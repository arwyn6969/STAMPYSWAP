// Compile the mainnet token (OpenZeppelin ERC20 + Ownable) → erc20-mainnet-artifact.json.
// solc-npm won't install here, and raw soljson has no import resolver — so we FLATTEN the OZ
// sources (in dependency order, stripping per-file SPDX/pragma/import lines) then compile with
// the same raw soljson.cwrap pattern gen-erc20.js uses.
const fs = require('fs')
const path = require('path')
const soljson = require('./soljson.js')

const OZ = path.join(__dirname, 'node_modules', '@openzeppelin', 'contracts')
// dependency order: Context → IERC20 → IERC20Metadata → ERC20 → Ownable → our token
const FILES = [
  path.join(OZ, 'utils', 'Context.sol'),
  path.join(OZ, 'token', 'ERC20', 'IERC20.sol'),
  path.join(OZ, 'token', 'ERC20', 'extensions', 'IERC20Metadata.sol'),
  path.join(OZ, 'token', 'ERC20', 'ERC20.sol'),
  path.join(OZ, 'access', 'Ownable.sol'),
  path.join(__dirname, 'StampyRepMainnet.sol'),
]
const strip = (src) => src.split('\n')
  .filter(l => !/^\s*(\/\/\s*SPDX-License-Identifier|pragma\s+solidity|import\s)/.test(l))
  .join('\n')

const flat = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\n' + FILES.map(f => `// ===== ${path.basename(f)} =====\n` + strip(fs.readFileSync(f, 'utf8'))).join('\n\n')
fs.writeFileSync(path.join(__dirname, 'StampyRepMainnet.flat.sol'), flat)

const input = {
  language: 'Solidity',
  sources: { 'StampyRep.sol': { content: flat } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}
const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number'])
const out = JSON.parse(compile(JSON.stringify(input), 0))
if (out.errors) {
  const fatal = out.errors.filter(e => e.severity === 'error')
  out.errors.forEach(e => console.log(e.severity + ':', e.formattedMessage.split('\n')[0]))
  if (fatal.length) { console.error('COMPILE FAILED'); process.exit(1) }
}
const c = out.contracts['StampyRep.sol'].StampyRep
fs.writeFileSync(path.join(__dirname, 'erc20-mainnet-artifact.json'), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2))
console.log('✅ erc20-mainnet-artifact.json — abi', c.abi.length, 'entries | bytecode', c.evm.bytecode.object.length / 2, 'bytes')
