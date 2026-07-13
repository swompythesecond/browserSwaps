// Generates a fresh EVM keypair for use as a deployer. Prints the private key
// to stdout — treat it accordingly (for testnet it's disposable; for mainnet
// deployment fund it with only the ~$1 the deploy needs).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log('address:    ', account.address);
console.log('private key:', pk);
console.log('\nFund the address with a little ETH on the target network, then:');
console.log('  set DEPLOYER_KEY=' + pk);
console.log('  node scripts/deploy-htlc.mjs arbitrumSepolia');
