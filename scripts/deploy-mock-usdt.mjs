// Deploys contracts/MockUSDT.sol to Arbitrum Sepolia (TESTNET ONLY) and mints
// the deployer 10,000 tUSDT to hand out to test browsers.
//
// Usage:
//   set DEPLOYER_KEY=0x<private key with a little Sepolia ETH>
//   node scripts/deploy-mock-usdt.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(fs.readFileSync(path.join(here, '../src/evm/mockusdt.artifact.json'), 'utf8'));

const pk = process.env.DEPLOYER_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error('set DEPLOYER_KEY=0x<64 hex chars> in the environment');
  process.exit(1);
}

const rpc = 'https://sepolia-rollup.arbitrum.io/rpc';
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ chain: arbitrumSepolia, account, transport: http(rpc) });
const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });

console.log(`deploying MockUSDT from ${account.address} to Arbitrum Sepolia…`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
const receipt = await client.waitForTransactionReceipt({ hash });
const token = receipt.contractAddress;
console.log('MockUSDT deployed at:', token);

console.log('minting 10,000 tUSDT to the deployer…');
const mintHash = await wallet.writeContract({
  address: token, abi: artifact.abi, functionName: 'mint', args: [10_000_000_000n], // 10,000 * 1e6
});
await client.waitForTransactionReceipt({ hash: mintHash });
console.log('done. balance: 10,000 tUSDT at', account.address);
console.log('\nPaste this token address into BrowserSwaps → Settings → "Token override",');
console.log('then send some tUSDT (and a little Sepolia ETH for gas) to each test browser\'s');
console.log('Arbitrum trading wallet address (shown on the Wallet tab).');
