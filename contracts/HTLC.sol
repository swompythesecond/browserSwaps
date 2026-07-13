// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * BrowserSwaps HTLC v2 — hashed-timelock escrow for ERC-20 tokens with
 * RELAYER support, so end users never need ETH:
 *
 *   - lockWithPermit(): the token payer signs two OFFLINE messages (an
 *     EIP-2612 permit + an EIP-712 LockIntent); any relayer submits them,
 *     pays the gas, and is compensated `lockFee` in tokens. The intent
 *     signature binds every parameter, so a relayer can alter nothing —
 *     it either submits the lock exactly as signed, or nothing happens.
 *   - claim()/refund(): callable by anyone; a non-beneficiary caller earns
 *     `relayFee` from the payout, the beneficiary receives the rest. When
 *     the beneficiary self-submits, no fee is taken.
 *
 * Relayers are pure gas stations: they can never redirect funds, only
 * decline to help — in which case anyone (including the users themselves,
 * with a little ETH) can submit the very same calls.
 *
 * No owner, no admin, no upgrade path. One deployment serves everyone.
 */
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

contract HTLC {
    struct Lock {
        address token;
        address sender;
        address recipient;
        uint256 amount;    // escrowed tokens (relayFee comes out of this on relayed exits)
        bytes32 hashlock;  // sha256(secret), secret must be exactly 32 bytes
        uint256 timelock;  // unix seconds; refund allowed at/after this time
        uint256 relayFee;  // paid to a non-beneficiary caller of claim/refund
        bool claimed;
        bool refunded;
    }

    /// Signed by the token payer; authorizes a relayer to create exactly this lock.
    struct LockIntent {
        address token;
        uint256 amount;
        bytes32 hashlock;
        address recipient;
        uint256 timelock;
        uint256 lockFee;   // paid to the relayer that submits the lock
        uint256 relayFee;  // stored in the lock for claim/refund relaying
        uint256 deadline;  // intent expiry (unix seconds)
    }

    /// Signed by a token holder; authorizes a relayer to move tokens to `to`
    /// (a plain withdrawal) and take `fee` for the gas. Binds the destination
    /// so a relayer can execute only the exact transfer the user signed.
    struct WithdrawIntent {
        address token;
        address to;
        uint256 amount;
        uint256 fee;      // paid to the relayer (msg.sender)
        uint256 deadline; // unix seconds
        bytes32 salt;     // uniqueness / replay protection
    }

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "LockIntent(address token,uint256 amount,bytes32 hashlock,address recipient,uint256 timelock,uint256 lockFee,uint256 relayFee,uint256 deadline)"
    );
    bytes32 private constant WITHDRAW_TYPEHASH = keccak256(
        "WithdrawIntent(address token,address to,uint256 amount,uint256 fee,uint256 deadline,bytes32 salt)"
    );
    bytes32 private immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => Lock) public locks;
    /// Spent withdrawal intents (keyed by their EIP-712 struct hash).
    mapping(bytes32 => bool) public usedWithdrawals;

    event Locked(
        bytes32 indexed id,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BrowserSwapsHTLC"),
            keccak256("2"),
            block.chainid,
            address(this)
        ));
    }

    // ------------------------------------------------------------------ lock

    /** Self-service lock (caller pays gas and needs prior approve). */
    function lock(
        address token,
        uint256 amount,
        bytes32 hashlock,
        address recipient,
        uint256 timelock,
        uint256 relayFee
    ) external returns (bytes32 id) {
        id = _createLock(msg.sender, token, amount, hashlock, recipient, timelock, relayFee);
        _safeTransferFrom(token, msg.sender, address(this), amount);
    }

    /**
     * Relayed, gasless-for-the-user lock. `intentSig` (EIP-712 over LockIntent,
     * this contract's domain) identifies and binds the token payer; the permit
     * authorizes the token pull. The permit call is tolerated to fail (e.g.
     * griefed by front-running) as long as the resulting allowance suffices.
     */
    function lockWithPermit(
        LockIntent calldata it,
        bytes calldata intentSig,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 pv, bytes32 pr, bytes32 ps
    ) external returns (bytes32 id) {
        require(block.timestamp <= it.deadline, "intent expired");
        address signer = _recoverIntent(it, intentSig);
        require(permitValue >= it.amount + it.lockFee, "permit value too small");

        try IERC2612(it.token).permit(signer, address(this), permitValue, permitDeadline, pv, pr, ps) {
        } catch { /* allowance may already be in place */ }

        id = _createLock(signer, it.token, it.amount, it.hashlock, it.recipient, it.timelock, it.relayFee);
        _safeTransferFrom(it.token, signer, address(this), it.amount);
        if (it.lockFee > 0 && msg.sender != signer) {
            _safeTransferFrom(it.token, signer, msg.sender, it.lockFee);
        }
    }

    function _createLock(
        address sender,
        address token,
        uint256 amount,
        bytes32 hashlock,
        address recipient,
        uint256 timelock,
        uint256 relayFee
    ) private returns (bytes32 id) {
        require(amount > 0, "amount=0");
        require(recipient != address(0), "recipient=0");
        require(timelock > block.timestamp, "timelock in past");
        require(relayFee < amount, "relayFee >= amount");
        id = keccak256(abi.encode(sender, recipient, token, amount, hashlock, timelock));
        require(locks[id].sender == address(0), "duplicate lock");
        locks[id] = Lock(token, sender, recipient, amount, hashlock, timelock, relayFee, false, false);
        emit Locked(id, sender, recipient, token, amount, hashlock, timelock);
    }

    function _recoverIntent(LockIntent calldata it, bytes calldata sig) private view returns (address) {
        return _recover(keccak256(abi.encode(
            INTENT_TYPEHASH, it.token, it.amount, it.hashlock, it.recipient,
            it.timelock, it.lockFee, it.relayFee, it.deadline
        )), sig);
    }

    /// Wrap a struct hash in this contract's EIP-712 domain and recover the signer.
    function _recover(bytes32 structHash, bytes calldata sig) private view returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signature");
        return signer;
    }

    /**
     * Relayed, gasless-for-the-user token withdrawal. The user signs a
     * WithdrawIntent (binding token/to/amount/fee) plus an EIP-2612 permit;
     * any relayer submits both, pays the gas, sends `amount` to `to`, and
     * keeps `fee`. The relayer can execute only the exact transfer signed —
     * it cannot change the destination or amount.
     */
    function withdrawWithPermit(
        WithdrawIntent calldata it,
        bytes calldata intentSig,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 pv, bytes32 pr, bytes32 ps
    ) external {
        require(block.timestamp <= it.deadline, "intent expired");
        require(it.to != address(0), "to=0");
        require(it.amount > 0, "amount=0");
        bytes32 structHash = keccak256(abi.encode(
            WITHDRAW_TYPEHASH, it.token, it.to, it.amount, it.fee, it.deadline, it.salt
        ));
        require(!usedWithdrawals[structHash], "withdrawal already used");
        usedWithdrawals[structHash] = true;
        address signer = _recover(structHash, intentSig);
        require(permitValue >= it.amount + it.fee, "permit value too small");

        try IERC2612(it.token).permit(signer, address(this), permitValue, permitDeadline, pv, pr, ps) {
        } catch { /* allowance may already be in place */ }

        _safeTransferFrom(it.token, signer, it.to, it.amount);
        if (it.fee > 0 && msg.sender != signer) {
            _safeTransferFrom(it.token, signer, msg.sender, it.fee);
        }
    }

    // ------------------------------------------------------------ claim/refund

    /**
     * Reveal the secret, release tokens to the fixed recipient. Callable by
     * anyone; a third-party caller earns the lock's relayFee.
     */
    function claim(bytes32 id, bytes32 secret) external {
        Lock storage l = locks[id];
        require(l.sender != address(0), "unknown lock");
        require(!l.claimed && !l.refunded, "already closed");
        require(sha256(abi.encodePacked(secret)) == l.hashlock, "bad secret");
        l.claimed = true;
        _payout(l.token, l.recipient, l.amount, l.relayFee);
        emit Claimed(id, secret);
    }

    /** Return tokens to the sender once the timelock has expired. Relayable. */
    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        require(l.sender != address(0), "unknown lock");
        require(!l.claimed && !l.refunded, "already closed");
        require(block.timestamp >= l.timelock, "timelock not reached");
        l.refunded = true;
        _payout(l.token, l.sender, l.amount, l.relayFee);
        emit Refunded(id);
    }

    function _payout(address token, address beneficiary, uint256 amount, uint256 relayFee) private {
        if (msg.sender != beneficiary && relayFee > 0) {
            _safeTransfer(token, msg.sender, relayFee);
            _safeTransfer(token, beneficiary, amount - relayFee);
        } else {
            _safeTransfer(token, beneficiary, amount);
        }
    }

    // --- USDT-compatible token transfer (tolerates missing return values) ---

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount)); // transferFrom(address,address,uint256)
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
    }
}
