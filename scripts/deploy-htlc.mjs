// Deploys contracts/HTLC.sol (compiled artifact) to Arbitrum One or Arbitrum
// Sepolia. The deployer key never touches the app — this is a one-time,
// ops-only step. The contract has no owner; the deployer has no special power.
//
// Usage:
//   set DEPLOYER_KEY=0x<private key with a little ETH on the target network>
//   node scripts/deploy-htlc.mjs arbitrumSepolia   (or: arbitrum)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia } from 'viem/chains';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(fs.readFileSync(path.join(here, '../src/evm/htlc.artifact.json'), 'utf8'));

const networks = {
  arbitrum: { chain: arbitrum, rpc: 'https://arb1.arbitrum.io/rpc' },
  arbitrumSepolia: { chain: arbitrumSepolia, rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
};

const target = networks[process.argv[2] ?? ''];
if (!target) {
  console.error('usage: node scripts/deploy-htlc.mjs <arbitrum|arbitrumSepolia>');
  process.exit(1);
}
const pk = process.env.DEPLOYER_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error('set DEPLOYER_KEY=0x<64 hex chars> in the environment');
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ chain: target.chain, account, transport: http(target.rpc) });
const client = createPublicClient({ chain: target.chain, transport: http(target.rpc) });

console.log(`deploying HTLC from ${account.address} to ${target.chain.name}…`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
console.log('deploy tx:', hash);
const receipt = await client.waitForTransactionReceipt({ hash });
console.log('HTLC deployed at:', receipt.contractAddress);
console.log('\nPaste this address into BrowserSwaps → Settings → HTLC contract,');
console.log('or bake it into src/config.ts as the default for this network.');
