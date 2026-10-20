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
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } },
}
const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number'])
const out = JSON.parse(compile(JSON.stringify(input), 0))
if (out.errors) {
  const fatal = out.errors.filter(e => e.severity === 'error')
  out.errors.forEach(e => console.log(e.severity + ':', e.formattedMessage.split('\n')[0]))
  if (fatal.length) { console.error('COMPILE FAILED'); process.exit(1) }
}
const c = out.contracts['StampyRep.sol'].StampyRep
const ast = out.sources['StampyRep.sol'].ast
const contract = ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === 'StampyRep')
const immutableDeclarations = []
function findImmutables(node) {
  if (!node || typeof node !== 'object') return
  if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') immutableDeclarations.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(findImmutables)
    else if (value && typeof value === 'object') findImmutables(value)
  }
}
findImmutables(ast)
const declaration = immutableDeclarations[0]
if (!contract || immutableDeclarations.length !== 1 || declaration.name !== '_decimals' || !declaration.stateVariable || declaration.scope !== contract.id || declaration.typeDescriptions.typeString !== 'uint8')
  throw new Error('runtime proof supports only StampyRep\'s sole uint8 immutable _decimals; compiler AST layout changed')
const deployed = c.evm.deployedBytecode
const ids = Object.keys(deployed.immutableReferences)
const refs = deployed.immutableReferences[String(declaration.id)]
if (ids.length !== 1 || ids[0] !== String(declaration.id) || !Array.isArray(refs) || !refs.length || !/^(?:[a-f0-9]{2})+$/i.test(deployed.object))
  throw new Error('missing or unexpected compiler immutable references')
let end = 0
for (const ref of refs) {
  if (!Number.isSafeInteger(ref.start) || ref.start < Math.max(1, end) || ref.length !== 32 || ref.start + ref.length > deployed.object.length / 2 ||
      deployed.object.slice((ref.start - 1) * 2, ref.start * 2).toLowerCase() !== '7f' || deployed.object.slice(ref.start * 2, (ref.start + ref.length) * 2) !== '0'.repeat(64))
    throw new Error('unsupported compiler immutable location, width, order or placeholder')
  end = ref.start + ref.length
}
const artifact = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + deployed.object,
  immutableReferences: deployed.immutableReferences,
  immutableBinding: { astId: declaration.id, contract: contract.name, name: declaration.name, type: declaration.typeDescriptions.typeString } }
fs.writeFileSync(path.join(__dirname, 'erc20-mainnet-artifact.json'), JSON.stringify(artifact, null, 2))
console.log('erc20-mainnet-artifact.json — abi', c.abi.length, 'entries | creation', c.evm.bytecode.object.length / 2, 'bytes | runtime', deployed.object.length / 2, 'bytes | immutable _decimals', declaration.id)
