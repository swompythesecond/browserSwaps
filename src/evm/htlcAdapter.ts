/**
 * EvmAdapter implementation against the deployed HTLC v2 contract on Arbitrum.
 *
 * Gasless-first: locks, claims and refunds are handed to a relayer ("gas
 * station") when one is reachable, so users need zero ETH. Every relayed
 * operation is bound by the user's EIP-712 signatures or by contract-fixed
 * parameters — a relayer can submit-or-decline, never alter. If no relayer
 * responds, the adapter falls back to self-submitting (which needs ETH).
 *
 * Verification model (unchanged from v1): value-bearing DECISIONS (the seller
 * committing BRC because a USDT lock exists) require independent agreement
 * from every reachable configured RPC, minimum quorum 2. A lying RPC can
 * stall a swap, never fake a lock.
 */
import {
  createPublicClient, createWalletClient, http, fallback,
  encodeAbiParameters, keccak256, erc20Abi, parseSignature,
  type PublicClient, type WalletClient, type Chain,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { EvmAdapter, EvmLockView } from '../swap/types.js';
import {
  RELAY, relayerFee, LOCK_FEE_BPS, CLAIM_FEE_BPS, WITHDRAW_FEE_BPS,
  type EvmNetworkConfig,
} from '../config.js';
import artifact from './htlc.artifact.json';

const HTLC_ABI = artifact.abi;

const INTENT_TYPES = {
  LockIntent: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'hashlock', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'timelock', type: 'uint256' },
    { name: 'lockFee', type: 'uint256' },
    { name: 'relayFee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const WITHDRAW_TYPES = {
  WithdrawIntent: [
    { name: 'token', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

export class HtlcEvmAdapter implements EvmAdapter {
  private wallet: WalletClient;
  private primary: PublicClient;
  /** One independent client per RPC for cross-checked reads. */
  private verifiers: PublicClient[];
  private tokenName: string | null = null;

  constructor(
    private readonly cfg: EvmNetworkConfig,
    private readonly account: PrivateKeyAccount,
    private readonly relayerUrls: string[] = [],
  ) {
    if (!cfg.htlc) throw new Error('HTLC contract address not configured (Settings)');
    if (!cfg.token) throw new Error('token address not configured (Settings)');
    const chain = cfg.chain as Chain;
    this.primary = createPublicClient({
      chain, transport: fallback(cfg.rpcs.map((u) => http(u, { timeout: 15_000 }))),
    });
    this.verifiers = cfg.rpcs.map((u) =>
      createPublicClient({ chain: chain, transport: http(u, { timeout: 10_000 }) }));
    this.wallet = createWalletClient({
      chain, account, transport: fallback(cfg.rpcs.map((u) => http(u, { timeout: 15_000 }))),
    });
  }

  address(): string {
    return this.account.address;
  }

  computeLockId(p: {
    sender: string; recipient: string; token: string;
    amount: bigint; hashlock: string; timelock: number;
  }): string {
    // Mirrors the contract: keccak256(abi.encode(sender, recipient, token, amount, hashlock, timelock))
    return keccak256(encodeAbiParameters(
      [
        { type: 'address' }, { type: 'address' }, { type: 'address' },
        { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' },
      ],
      [
        p.sender as `0x${string}`,
        p.recipient as `0x${string}`,
        (p.token || this.cfg.token) as `0x${string}`,
        p.amount,
        `0x${p.hashlock}` as `0x${string}`,
        BigInt(p.timelock),
      ],
    ));
  }

  // ------------------------------------------------------------------- lock

  async lock(p: { amount: bigint; hashlock: string; recipient: string; timelock: number }):
    Promise<{ lockId: string; txHash: string }> {
    const lockId = this.computeLockId({
      sender: this.account.address, recipient: p.recipient, token: this.cfg.token,
      amount: p.amount, hashlock: p.hashlock, timelock: p.timelock,
    });
    // gasless path first
    try {
      const txHash = await this.relayedLock(p);
      return { lockId, txHash };
    } catch (e) {
      console.warn('relayed lock unavailable, falling back to self-submit:', (e as Error).message);
    }
    // self-submit fallback (requires ETH for gas)
    const txHash = await this.directLock(p);
    return { lockId, txHash };
  }

  /** Sign a LockIntent + an EIP-2612 permit, hand both to a relayer. */
  private async relayedLock(p: {
    amount: bigint; hashlock: string; recipient: string; timelock: number;
  }): Promise<string> {
    if (this.relayerUrls.length === 0) throw new Error('no relayers configured');
    const chainId = (this.cfg.chain as Chain).id;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + RELAY.intentTtlSecs);
    const lockFee = relayerFee(p.amount, LOCK_FEE_BPS);
    const relayFee = relayerFee(p.amount, CLAIM_FEE_BPS);
    const permitValue = p.amount + lockFee;

    // 1. LockIntent signature (binds every parameter to us, the token payer)
    const intent = {
      token: this.cfg.token as `0x${string}`,
      amount: p.amount,
      hashlock: `0x${p.hashlock}` as `0x${string}`,
      recipient: p.recipient as `0x${string}`,
      timelock: BigInt(p.timelock),
      lockFee,
      relayFee,
      deadline,
    };
    const intentSig = await this.account.signTypedData({
      domain: {
        name: 'BrowserSwapsHTLC', version: '2',
        chainId, verifyingContract: this.cfg.htlc as `0x${string}`,
      },
      types: INTENT_TYPES, primaryType: 'LockIntent', message: intent,
    });

    // 2. permit signature (authorizes the contract to pull amount + lockFee)
    const [nonce, name] = await Promise.all([
      this.primary.readContract({
        address: this.cfg.token as `0x${string}`,
        abi: [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'nonces', args: [this.account.address],
      }),
      this.getTokenName(),
    ]);
    const permitSig = await this.account.signTypedData({
      domain: {
        name, version: '1',
        chainId, verifyingContract: this.cfg.token as `0x${string}`,
      },
      types: PERMIT_TYPES, primaryType: 'Permit',
      message: {
        owner: this.account.address,
        spender: this.cfg.htlc as `0x${string}`,
        value: permitValue, nonce, deadline,
      },
    });
    const { v, r, s } = parseSignature(permitSig);

    // 3. hand to a relayer
    return this.postToRelayer({
      op: 'lockWithPermit',
      intent: {
        token: intent.token, amount: intent.amount.toString(), hashlock: intent.hashlock,
        recipient: intent.recipient, timelock: intent.timelock.toString(),
        lockFee: intent.lockFee.toString(), relayFee: intent.relayFee.toString(),
        deadline: intent.deadline.toString(),
      },
      intentSig,
      permitValue: permitValue.toString(),
      permitDeadline: deadline.toString(),
      pv: Number(v ?? 27n), pr: r, ps: s,
    });
  }

  private async directLock(p: {
    amount: bigint; hashlock: string; recipient: string; timelock: number;
  }): Promise<string> {
    const chain = this.cfg.chain as Chain;
    const allowance = await this.primary.readContract({
      address: this.cfg.token as `0x${string}`, abi: erc20Abi, functionName: 'allowance',
      args: [this.account.address, this.cfg.htlc as `0x${string}`],
    });
    if (allowance < p.amount) {
      // USDT requires resetting a nonzero allowance to 0 before changing it.
      if (allowance > 0n) {
        const reset = await this.wallet.writeContract({
          chain, account: this.account,
          address: this.cfg.token as `0x${string}`, abi: erc20Abi,
          functionName: 'approve', args: [this.cfg.htlc as `0x${string}`, 0n],
        });
        await this.primary.waitForTransactionReceipt({ hash: reset });
      }
      const approve = await this.wallet.writeContract({
        chain, account: this.account,
        address: this.cfg.token as `0x${string}`, abi: erc20Abi,
        functionName: 'approve', args: [this.cfg.htlc as `0x${string}`, p.amount],
      });
      await this.primary.waitForTransactionReceipt({ hash: approve });
    }
    const txHash = await this.wallet.writeContract({
      chain, account: this.account,
      address: this.cfg.htlc as `0x${string}`, abi: HTLC_ABI, functionName: 'lock',
      args: [
        this.cfg.token as `0x${string}`, p.amount,
        `0x${p.hashlock}` as `0x${string}`,
        p.recipient as `0x${string}`, BigInt(p.timelock), relayerFee(p.amount, CLAIM_FEE_BPS),
      ],
    });
    await this.primary.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  // ----------------------------------------------------------- claim/refund

  async claim(lockId: string, secret: string): Promise<string> {
    try {
      return await this.postToRelayer({ op: 'claim', id: lockId, secret: `0x${secret}` });
    } catch (e) {
      console.warn('relayed claim unavailable, self-submitting:', (e as Error).message);
    }
    const txHash = await this.wallet.writeContract({
      chain: this.cfg.chain as Chain, account: this.account,
      address: this.cfg.htlc as `0x${string}`, abi: HTLC_ABI, functionName: 'claim',
      args: [lockId as `0x${string}`, `0x${secret}` as `0x${string}`],
    });
    await this.primary.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  async refund(lockId: string): Promise<string> {
    try {
      return await this.postToRelayer({ op: 'refund', id: lockId });
    } catch (e) {
      console.warn('relayed refund unavailable, self-submitting:', (e as Error).message);
    }
    const txHash = await this.wallet.writeContract({
      chain: this.cfg.chain as Chain, account: this.account,
      address: this.cfg.htlc as `0x${string}`, abi: HTLC_ABI, functionName: 'refund',
      args: [lockId as `0x${string}`],
    });
    await this.primary.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  private async postToRelayer(body: Record<string, unknown>): Promise<string> {
    let lastError = 'no relayers configured';
    for (const url of this.relayerUrls) {
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/relay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const out = await res.json() as { ok: boolean; txHash?: string; error?: string };
        if (out.ok && out.txHash) return out.txHash;
        lastError = out.error ?? `relayer ${url} refused`;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    throw new Error(lastError);
  }

  // --------------------------------------------------------- withdrawals

  /** Gasless withdrawal: sign a WithdrawIntent + permit, hand to a relayer.
   * Falls back to a self-submitted transfer (needs ETH) if no relayer answers. */
  async withdraw(to: string, amount: bigint): Promise<string> {
    let relayError: string;
    try {
      return await this.relayedWithdraw(to, amount);
    } catch (e) {
      relayError = (e as Error).message;
      console.warn('relayed withdrawal unavailable:', relayError);
    }
    // The gasless relayer is the product promise ("no ETH needed"). Only self-
    // submit a direct transfer if the wallet actually has ETH for gas —
    // otherwise it's guaranteed to fail with a confusing "insufficient funds"
    // error that hides the real relayer problem.
    const eth = await this.primary.getBalance({ address: this.account.address }).catch(() => 0n);
    if (eth < 100_000_000_000_000n) { // < 0.0001 ETH: can't self-submit
      throw new Error(`the relayer couldn't process your gasless withdrawal (${relayError}). Your funds are safe — try again in a moment, or ask the operator to check the relayer.`);
    }
    const txHash = await this.wallet.writeContract({
      chain: this.cfg.chain as Chain, account: this.account,
      address: this.cfg.token as `0x${string}`, abi: erc20Abi,
      functionName: 'transfer', args: [to as `0x${string}`, amount],
    });
    await this.primary.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  private async relayedWithdraw(to: string, amount: bigint): Promise<string> {
    if (this.relayerUrls.length === 0) throw new Error('no relayers configured');
    const chainId = (this.cfg.chain as Chain).id;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + RELAY.intentTtlSecs);
    const fee = relayerFee(amount, WITHDRAW_FEE_BPS);
    const permitValue = amount + fee;
    const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;

    const intent = {
      token: this.cfg.token as `0x${string}`,
      to: to as `0x${string}`,
      amount, fee, deadline, salt,
    };
    const intentSig = await this.account.signTypedData({
      domain: { name: 'BrowserSwapsHTLC', version: '2', chainId, verifyingContract: this.cfg.htlc as `0x${string}` },
      types: WITHDRAW_TYPES, primaryType: 'WithdrawIntent', message: intent,
    });

    const [nonce, name] = await Promise.all([
      this.primary.readContract({
        address: this.cfg.token as `0x${string}`,
        abi: [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'nonces', args: [this.account.address],
      }),
      this.getTokenName(),
    ]);
    const permitSig = await this.account.signTypedData({
      domain: { name, version: '1', chainId, verifyingContract: this.cfg.token as `0x${string}` },
      types: PERMIT_TYPES, primaryType: 'Permit',
      message: { owner: this.account.address, spender: this.cfg.htlc as `0x${string}`, value: permitValue, nonce, deadline },
    });
    const { v, r, s } = parseSignature(permitSig);

    return this.postToRelayer({
      op: 'withdrawWithPermit',
      intent: { token: intent.token, to: intent.to, amount: amount.toString(), fee: fee.toString(), deadline: deadline.toString(), salt },
      intentSig,
      permitValue: permitValue.toString(),
      permitDeadline: deadline.toString(),
      pv: Number(v ?? 27n), pr: r, ps: s,
    });
  }

  // ------------------------------------------------------------------ reads

  async getLock(lockId: string): Promise<EvmLockView | null> {
    // v2 struct: token, sender, recipient, amount, hashlock, timelock, relayFee, claimed, refunded
    type Row = readonly [string, string, string, bigint, string, bigint, bigint, boolean, boolean];
    const reads = await Promise.allSettled(this.verifiers.map(async (client) => {
      const row = await client.readContract({
        address: this.cfg.htlc as `0x${string}`, abi: HTLC_ABI,
        functionName: 'locks', args: [lockId as `0x${string}`],
      }) as Row;
      const block = await client.getBlock({ blockTag: 'latest' });
      return { row, blockTime: Number(block.timestamp) };
    }));
    const oks = reads.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (oks.length < Math.min(2, this.verifiers.length)) {
      throw new Error('not enough RPCs reachable to verify lock');
    }
    const views = oks.filter((o) => o.row[1] !== '0x0000000000000000000000000000000000000000');
    if (views.length === 0) return null;
    // ALL reachable RPCs that see the lock must agree on the immutable fields.
    const key = (o: typeof oks[number]): string =>
      [o.row[0], o.row[1], o.row[2], o.row[3], o.row[4], o.row[5], o.row[6]].join('|').toLowerCase();
    if (new Set(views.map(key)).size > 1) throw new Error('RPCs disagree about lock — refusing to proceed');
    if (views.length < Math.min(2, this.verifiers.length)) return null; // quorum must SEE it
    const v = views[0]!;
    let safe = false;
    try {
      const safeRow = await this.primary.readContract({
        address: this.cfg.htlc as `0x${string}`, abi: HTLC_ABI,
        functionName: 'locks', args: [lockId as `0x${string}`], blockTag: 'safe',
      }) as Row;
      safe = safeRow[1] !== '0x0000000000000000000000000000000000000000';
    } catch {
      safe = false; // RPC lacks `safe` tag support: treat as not yet L1-posted
    }
    const firstSeenKey = `bswap.lockseen.${lockId}`;
    let firstSeen = Number(localStorage.getItem(firstSeenKey) ?? '0');
    if (!firstSeen) {
      firstSeen = Math.max(...views.map((o) => o.blockTime));
      localStorage.setItem(firstSeenKey, String(firstSeen));
    }
    const nowChain = Math.max(...views.map((o) => o.blockTime));
    return {
      token: v.row[0],
      sender: v.row[1],
      recipient: v.row[2],
      amount: v.row[3],
      hashlock: (v.row[4] as string).replace(/^0x/, ''),
      timelock: Number(v.row[5]),
      claimed: v.row[7],
      refunded: v.row[8],
      safe,
      ageSecs: Math.max(0, nowChain - firstSeen),
    };
  }

  private async getTokenName(): Promise<string> {
    if (this.tokenName) return this.tokenName;
    this.tokenName = await this.primary.readContract({
      address: this.cfg.token as `0x${string}`, abi: erc20Abi, functionName: 'name',
    });
    return this.tokenName;
  }

  // ---- wallet view: balances ----

  async tokenBalance(): Promise<bigint> {
    return this.primary.readContract({
      address: this.cfg.token as `0x${string}`, abi: erc20Abi,
      functionName: 'balanceOf', args: [this.account.address],
    });
  }

  async ethBalance(): Promise<bigint> {
    return this.primary.getBalance({ address: this.account.address });
  }
}
