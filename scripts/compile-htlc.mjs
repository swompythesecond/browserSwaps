// Compiles every contract in contracts/ with solc-js and writes artifacts
// (ABI + creation bytecode) to src/evm/<name>.artifact.json. The app imports
// the HTLC artifact; the deploy scripts consume all of them.
// Run: npm run compile:htlc
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.join(here, '../contracts');

const sources = {};
for (const f of fs.readdirSync(contractsDir).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: fs.readFileSync(path.join(contractsDir, f), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 1000 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const fatal = (out.errors ?? []).filter((e) => e.severity === 'error');
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (fatal.length) process.exit(1);

for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces/abstract: nothing to deploy
    const artifact = {
      contractName: name,
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      compiler: 'solc ' + solc.version(),
    };
    const dest = path.join(here, '../src/evm', `${name.toLowerCase()}.artifact.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(artifact, null, 2));
    console.log(`${file} -> ${dest} (${artifact.bytecode.length / 2 - 1} bytes)`);
  }
}
