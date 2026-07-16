/**
 * bswap-htlc program tests, run by `anchor test` against a local validator.
 *
 * The cast mirrors production roles:
 *   sender    — token payer (the swap buyer locking USDC/USDT), has no SOL
 *               use beyond signing (the relayer is fee payer in prod; here
 *               both are funded for simplicity, roles still exercised).
 *   recipient — swap counterparty; starts WITHOUT a token account so claim's
 *               init_if_needed ATA path is exercised.
 *   relayer   — third-party submitter earning lock_fee / relay_fee.
 *
 * Timelock tests use short real-time locks (the local validator clock is
 * wall-clock), so this suite deliberately sleeps a few seconds in places.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";
import type { BswapHtlc } from "../target/types/bswap_htlc";

const sha256 = (...bufs: Buffer[]) =>
  createHash("sha256").update(Buffer.concat(bufs)).digest();

const le64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, n));
  return b;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bswap-htlc", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.BswapHtlc as Program<BswapHtlc>;
  const conn = provider.connection;

  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const relayer = Keypair.generate();

  let mint: PublicKey;
  let senderToken: PublicKey;
  let relayerToken: PublicKey;
  const recipientAta = () => getAssociatedTokenAddressSync(mint, recipient.publicKey);
  const senderAta = () => getAssociatedTokenAddressSync(mint, sender.publicKey);

  const AMOUNT = 1_000_000n; // 1.0 token (6 dp)
  const RELAY_FEE = 2_000n; // 0.2%
  const LOCK_FEE = 2_000n;

  async function chainNow(): Promise<number> {
    const t = await conn.getBlockTime(await conn.getSlot());
    if (t === null) throw new Error("no block time");
    return t;
  }

  function lockIdFor(p: {
    sender: PublicKey;
    recipient: PublicKey;
    mint: PublicKey;
    amount: bigint;
    hashlock: Buffer;
    timelock: number;
  }): Buffer {
    return sha256(
      p.sender.toBuffer(),
      p.recipient.toBuffer(),
      p.mint.toBuffer(),
      le64(p.amount),
      p.hashlock,
      le64(BigInt(p.timelock))
    );
  }

  function pdas(lockId: Buffer) {
    const [lockState] = PublicKey.findProgramAddressSync(
      [Buffer.from("lock"), lockId],
      program.programId
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lockId],
      program.programId
    );
    return { lockState, vault };
  }

  /** Relayed lock: sender signs, relayer is fee payer + earns lockFee. */
  async function doLock(p: {
    amount: bigint;
    hashlock: Buffer;
    timelock: number;
    relayFee?: bigint;
    lockFee?: bigint;
    lockIdOverride?: Buffer;
    selfSubmit?: boolean;
  }) {
    const relayFee = p.relayFee ?? RELAY_FEE;
    const lockFee = p.lockFee ?? LOCK_FEE;
    const lockId =
      p.lockIdOverride ??
      lockIdFor({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint,
        amount: p.amount,
        hashlock: p.hashlock,
        timelock: p.timelock,
      });
    const { lockState, vault } = pdas(lockId);
    const payer = p.selfSubmit ? sender : relayer;
    await program.methods
      .lock(
        [...lockId],
        recipient.publicKey,
        new BN(p.amount.toString()),
        [...p.hashlock],
        new BN(p.timelock),
        new BN(relayFee.toString()),
        new BN(lockFee.toString())
      )
      .accountsStrict({
        sender: sender.publicKey,
        payer: payer.publicKey,
        mint,
        senderToken,
        payerToken: p.selfSubmit ? null : relayerToken,
        lockState,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(p.selfSubmit ? [sender] : [sender, relayer])
      .rpc();
    return { lockId, lockState, vault };
  }

  /** `code` may list alternatives with `|` — e.g. a settled lock rejects a
   * second settle as AlreadyClosed OR AccountNotInitialized (its vault was
   * closed by the first settle, and Anchor validates accounts before our
   * status check runs). Either way the funds can't move twice. */
  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const msg = String(e.error?.errorCode?.code ?? e.message ?? e);
      const codes = code.split('|');
      assert.isTrue(codes.some((c) => msg.includes(c)), `expected ${code}, got: ${msg}`);
      return;
    }
    assert.fail(`expected rejection with ${code}`);
  }

  const bal = async (addr: PublicKey) => (await getAccount(conn, addr)).amount;

  before(async () => {
    // Fund the actors and set up a 6-decimal mint (like USDC/USDT).
    for (const kp of [sender, recipient, relayer]) {
      const sig = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig);
    }
    mint = await createMint(conn, relayer, relayer.publicKey, null, 6);
    senderToken = await createAssociatedTokenAccount(conn, sender, mint, sender.publicKey);
    relayerToken = await createAssociatedTokenAccount(conn, relayer, mint, relayer.publicKey);
    await mintTo(conn, relayer, mint, senderToken, relayer, 100_000_000n);
    // recipient deliberately has NO token account — claim must create it.
  });

  it("locks: escrows amount, pays lockFee to the relaying fee payer", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 3600;
    const senderBefore = await bal(senderToken);
    const relayerBefore = await bal(relayerToken);

    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });

    assert.equal(await bal(vault), AMOUNT);
    assert.equal(await bal(senderToken), senderBefore - AMOUNT - LOCK_FEE);
    assert.equal(await bal(relayerToken), relayerBefore + LOCK_FEE);

    const s = await program.account.lockState.fetch(lockState);
    assert.equal(s.amount.toString(), AMOUNT.toString());
    assert.deepEqual(Buffer.from(s.hashlock), hashlock);
    assert.equal(s.timelock.toNumber(), timelock);
    assert.equal(s.sender.toBase58(), sender.publicKey.toBase58());
    assert.equal(s.recipient.toBase58(), recipient.publicKey.toBase58());
    assert.equal(s.rentPayer.toBase58(), relayer.publicKey.toBase58());
    assert.isDefined(s.status.open);
  });

  it("rejects a duplicate lock (same id)", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 3600;
    await doLock({ amount: AMOUNT, hashlock, timelock });
    // identical parameters => same PDA => init fails
    try {
      await doLock({ amount: AMOUNT, hashlock, timelock });
      assert.fail("expected duplicate lock to fail");
    } catch (e: any) {
      assert.match(String(e), /already in use|custom program error/i);
    }
  });

  it("rejects a lock id that does not hash the parameters", async () => {
    const hashlock = sha256(randomBytes(32));
    const timelock = (await chainNow()) + 3600;
    await expectErr(
      doLock({ amount: AMOUNT, hashlock, timelock, lockIdOverride: randomBytes(32) }),
      "BadLockId"
    );
  });

  it("rejects relayFee >= amount and past timelocks", async () => {
    const hashlock = sha256(randomBytes(32));
    const now = await chainNow();
    await expectErr(
      doLock({ amount: 100n, hashlock, timelock: now + 3600, relayFee: 100n }),
      "RelayFeeTooBig"
    );
    await expectErr(
      doLock({ amount: AMOUNT, hashlock, timelock: now - 10 }),
      "TimelockInPast"
    );
  });

  it("claims via relayer: fee to relayer, rest to a fresh recipient ATA, secret stored, vault closed", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 3600;
    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });
    const relayerBefore = await bal(relayerToken);

    await program.methods
      .claim([...secret])
      .accountsStrict({
        submitter: relayer.publicKey,
        lockState,
        vault,
        mint,
        recipient: recipient.publicKey,
        beneficiaryToken: recipientAta(),
        submitterToken: relayerToken,
        rentPayer: relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([relayer])
      .rpc();

    assert.equal(await bal(recipientAta()), AMOUNT - RELAY_FEE);
    assert.equal(await bal(relayerToken), relayerBefore + RELAY_FEE);
    assert.isNull(await conn.getAccountInfo(vault), "vault should be closed");
    const s = await program.account.lockState.fetch(lockState);
    assert.isDefined(s.status.claimed);
    assert.deepEqual(Buffer.from(s.secret), secret, "revealed secret readable from state");
  });

  it("self-claim by the recipient pays no relay fee", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 3600;
    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });
    const before = await bal(recipientAta());

    await program.methods
      .claim([...secret])
      .accountsStrict({
        submitter: recipient.publicKey,
        lockState,
        vault,
        mint,
        recipient: recipient.publicKey,
        beneficiaryToken: recipientAta(),
        submitterToken: null,
        rentPayer: relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient])
      .rpc();

    assert.equal(await bal(recipientAta()), before + AMOUNT, "full amount, no fee");
  });

  it("rejects a wrong secret and a double claim", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 3600;
    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });

    const claimWith = (sec: Buffer) =>
      program.methods
        .claim([...sec])
        .accountsStrict({
          submitter: relayer.publicKey,
          lockState,
          vault,
          mint,
          recipient: recipient.publicKey,
          beneficiaryToken: recipientAta(),
          submitterToken: relayerToken,
          rentPayer: relayer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();

    await expectErr(claimWith(randomBytes(32)), "BadSecret");
    await claimWith(secret);
    await expectErr(claimWith(secret), "AlreadyClosed|AccountNotInitialized");
  });

  it("refund: rejected before the timelock, works after, relayable with fee", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 8;
    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });
    const senderBefore = await bal(senderAta());
    const relayerBefore = await bal(relayerToken);

    const doRefund = () =>
      program.methods
        .refund()
        .accountsStrict({
          submitter: relayer.publicKey,
          lockState,
          vault,
          mint,
          sender: sender.publicKey,
          beneficiaryToken: senderAta(),
          submitterToken: relayerToken,
          rentPayer: relayer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();

    await expectErr(doRefund(), "TimelockNotReached");
    await sleep(11_000);
    await doRefund();

    assert.equal(await bal(senderAta()), senderBefore + AMOUNT - RELAY_FEE);
    assert.equal(await bal(relayerToken), relayerBefore + RELAY_FEE);
    const s = await program.account.lockState.fetch(lockState);
    assert.isDefined(s.status.refunded);

    // and a claim after refund must fail
    await expectErr(
      program.methods
        .claim([...secret])
        .accountsStrict({
          submitter: relayer.publicKey,
          lockState,
          vault,
          mint,
          recipient: recipient.publicKey,
          beneficiaryToken: recipientAta(),
          submitterToken: relayerToken,
          rentPayer: relayer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc(),
      "AlreadyClosed|AccountNotInitialized"
    );
  });

  it("reap: rejected while open or before timelock; closes state and returns rent afterwards", async () => {
    const secret = randomBytes(32);
    const hashlock = sha256(secret);
    const timelock = (await chainNow()) + 8;
    const { lockState, vault } = await doLock({ amount: AMOUNT, hashlock, timelock });

    const doReap = () =>
      program.methods
        .reap()
        .accountsStrict({ lockState, rentPayer: relayer.publicKey })
        .rpc();

    await expectErr(doReap(), "StillOpen");

    // settle it (self-claim, no fee complexity), then reap after the timelock
    await program.methods
      .claim([...secret])
      .accountsStrict({
        submitter: recipient.publicKey,
        lockState,
        vault,
        mint,
        recipient: recipient.publicKey,
        beneficiaryToken: recipientAta(),
        submitterToken: null,
        rentPayer: relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([recipient])
      .rpc();

    await expectErr(doReap(), "TimelockNotReached");
    await sleep(11_000);

    const rentBefore = await conn.getBalance(relayer.publicKey);
    await doReap();
    assert.isNull(await conn.getAccountInfo(lockState), "state should be closed");
    assert.isAbove(await conn.getBalance(relayer.publicKey), rentBefore);
  });

  it("self-submitted lock needs no fee account and pays no lock fee", async () => {
    const hashlock = sha256(randomBytes(32));
    const timelock = (await chainNow()) + 3600;
    const before = await bal(senderToken);
    const { vault } = await doLock({
      amount: AMOUNT,
      hashlock,
      timelock,
      selfSubmit: true,
      lockFee: 0n,
    });
    assert.equal(await bal(vault), AMOUNT);
    assert.equal(await bal(senderToken), before - AMOUNT);
  });
});
