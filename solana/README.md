# bswap-htlc — the BrowserSwaps HTLC program for Solana

The Solana twin of `contracts/HTLC.sol` v3: hashed-timelock escrow for SPL
tokens (USDC / USDT), with native fee-payer relaying instead of the EVM's
permit/intent machinery. See the doc comment in
`programs/bswap-htlc/src/lib.rs` for the full design.

Program id (from `target/deploy/bswap_htlc-keypair.json`, gitignored — back it
up if you deploy with it): `BgonehyDwfg8UtUKQW5TkYLAvFnJ47BRXu1TLYaDZ1dV`

## Building (Docker — no local Rust/Solana toolchain needed)

All commands run in the `solanafoundation/anchor:v0.31.1` image with this
directory mounted at `/work`:

```powershell
docker run --rm -v "$PWD\solana:/work" -w /work solanafoundation/anchor:v0.31.1 sh -c `
  "solana-keygen new --no-bip39-passphrase --silent --outfile /root/.config/solana/id.json 2>/dev/null; anchor build"
```

**Do not delete `Cargo.lock`.** The image's cargo is 1.79 while much of the
2025+ crates.io ecosystem requires edition2024 / rustc ≥1.85, so the lockfile
deliberately pins: `blake3 1.5.5` (drops cpufeatures 0.3), `proc-macro-crate
3.2.0` (drops the toml 1.x family), `zeroize 1.8.1` + `zeroize_derive 1.4.2`,
`cfg-if 1.0.0`, `borsh 1.5.7` (drops hashbrown 0.17), `indexmap 2.9.0`,
`unicode-segmentation 1.12.0`. A fresh resolve will not build in this image.
(Alternative: the `v0.32.1` image has rustc 1.90 and needs no pins, but its
anchor CLI is 0.32.)

## Testing (local validator, in the same container)

```powershell
docker run --rm -v "$PWD\solana:/work" -w /work solanafoundation/anchor:v0.31.1 sh -c `
  "solana-keygen new --no-bip39-passphrase --silent --outfile /root/.config/solana/id.json 2>/dev/null; `
   yarn install --ignore-engines; anchor test --skip-build"
```

10 tests cover lock/claim/refund/reap happy paths, fee payment to a relaying
third party vs fee-free self-submission, duplicate/forged lock ids, wrong
secrets, double settles, and timelock enforcement (the suite sleeps through
short real-time timelocks, so it takes ~40 s).

## Deploying

Devnet (the deployer keypair `.devnet-deployer.json` is gitignored;
fund it at https://faucet.solana.com — CLI airdrops are usually rate-limited):

```powershell
docker run --rm -v "$PWD\solana:/work" -w /work solanafoundation/anchor:v0.31.1 sh -c `
  "solana config set --url devnet --keypair /work/.devnet-deployer.json; `
   anchor deploy --provider.cluster devnet --provider.wallet /work/.devnet-deployer.json"
```

Mainnet-beta is the same with `--provider.cluster mainnet` and a funded
deployer (~2-3 SOL of program rent; recoverable by closing the program).
After deploying:

1. Put the program id in `src/config.ts` (`SOL_NETWORKS.<net>.htlcProgram`).
2. Server `.env`: `SOL_HTLC_PROGRAM=<program id>`, `SOL_RELAYER_KEY=<128 hex
   chars — a 64-byte Solana secret key>`, optionally `SOL_RPC=…`. Fund the
   relayer with SOL and create its USDC/USDT token accounts.
3. Consider `solana program set-upgrade-authority --final` once the mainnet
   rehearsal passes (the EVM contract has no admin either).
