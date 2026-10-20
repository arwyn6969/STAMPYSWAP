const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { ethers } = require('ethers')
const networks = require('../network-config')
const ROOT = path.join(__dirname, '..')
const owner = '0x' + '1'.repeat(40), address = '0x' + '2'.repeat(40), recipient = '0x' + '3'.repeat(40)
const origin = 'bitcoin:src-20:COIN', blockHash = '0x' + 'a'.repeat(64)
const env = { BASE_MAINNET_RPC: 'https://base.example.invalid', ETH_MAINNET_RPC: 'https://eth.example.invalid' }
const mainnetArtifact = require('../erc20-mainnet-artifact.json')
function compiledRuntime(decimals = 18) {
  // Independent fixed fixture for the reviewed compiler layout: one PUSH32 word at
  // byte 375. The generator/validator must reject any incompatible layout change.
  const code = Buffer.from(mainnetArtifact.deployedBytecode.slice(2), 'hex')
  Buffer.from(BigInt(decimals).toString(16).padStart(64, '0'), 'hex').copy(code, 375)
  return '0x' + code.toString('hex')
}
function load(file, deps) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { module, exports: module.exports, require: name => {
    if (Object.hasOwn(deps, name)) return deps[name]
    if (name.startsWith('./') && name.endsWith('.json')) return require(path.join(ROOT, name))
    throw Error('unexpected dependency: ' + name)
  }, process: { env }, __dirname: ROOT, console, Buffer })
  return module.exports
}
function fixture(chain = 'base-mainnet', artifact = mainnetArtifact) {
  const state = { chainId: ethers.toQuantity(networks.EVM_CHAINS[chain].chainId), code: networks.EVM_CHAINS[chain].mainnet ? compiledRuntime() : '0x6000', owner, decimals: 18n, origin, keys: 0, mint: 0, getters: 0,
    finalNumber: 12, canonicalHash: blockHash, receipt: { status: 1, blockNumber: 10, blockHash, logs: [{ address, topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(owner, 32), ethers.ZeroHash], data: ethers.toBeHex(10n * 10n ** 18n, 32) }] } }
  const provider = { send: async () => state.chainId, getCode: async () => state.code, getBalance: async () => 1n,
    getTransactionReceipt: async () => state.receipt, getBlockNumber: async () => 30,
    getBlock: async tag => { if (state.finalityError) throw Error('finalized RPC unsupported'); return tag === 'finalized' ? { number: state.finalNumber } : { number: 10, hash: state.canonicalHash } } }
  const signer = { provider: () => provider, serialize: async (_, fn) => fn(), emblemAddress: async () => owner,
    emblemSigner: async () => { state.keys++; return {} }, signer: () => { state.keys++; throw Error('raw signer forbidden') },
    get address() { state.keys++; throw Error('deployer key forbidden') } }
  const mod = load('evm-mint.js', { ethers: { ethers: { ...ethers, Contract: function () { return {
    owner: async () => { state.getters++; if (state.ownerError) throw Error('owner RPC unavailable'); return state.owner }, decimals: async () => state.decimals,
    srcOrigin: async () => state.origin, mint: async () => { state.mint++; return { wait: async () => ({ status: 1, hash: 'hash' }) } },
  } } } }, './network-config': { ...networks, evmChain: key => networks.evmChain(key, env) }, './evm-signer': signer, './erc20-mainnet-artifact.json': artifact })
  return { mod, state, provider }
}
test('mainnet selects the reviewed artifact with the same five-argument constructor', () => {
  const { mod } = fixture()
  assert.equal(mod.artifactFor('base-mainnet'), require('../erc20-mainnet-artifact.json'))
  assert.equal(mod.artifactFor('ethereum-mainnet'), require('../erc20-mainnet-artifact.json'))
  assert.equal(mod.artifactFor('base'), require('../erc20-artifact.json'))
  assert.equal(new ethers.Interface(mod.artifactFor('ethereum-mainnet').abi).deploy.inputs.map(input => input.type).join(','), 'string,string,uint8,string,address')
  const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
  assert.equal(sha256(JSON.stringify(mainnetArtifact.abi)), '32c8e9285bbde744fbc2d0fdf8ed8dd06b60e3166dfb44d20d5f0df566334a7c')
  assert.equal(sha256(mainnetArtifact.bytecode), 'ef3df01fad8555b459341a870a868d5f73a3a0b30a6f38adab3fb3e1ec4a0098')
  assert.deepEqual(mainnetArtifact.immutableReferences, { 825: [{ length: 32, start: 375 }] })
  assert.equal(mod.expectedMainnetRuntime(), compiledRuntime())
})
test('mainnet accepts exact compiled runtime case-insensitively', async () => {
  const { mod, state, provider } = fixture()
  state.code = '0x' + state.code.slice(2).toUpperCase()
  await mod.validateRepresentation({ chain: 'base-mainnet', address, provider, expectedOwner: owner, expectedOrigin: origin })
  assert.equal(state.getters, 1)
})
for (const variation of ['getter-compatible fake', 'single instruction byte', 'compiler metadata', 'wrong immutable value']) {
  test('mainnet rejects ' + variation + ' despite matching identity getters', async () => {
    const { mod, state, provider } = fixture()
    if (variation === 'getter-compatible fake') state.code = '0x60006000f3'
    else if (variation === 'single instruction byte') state.code = '0x61' + state.code.slice(4)
    else if (variation === 'compiler metadata') state.code = state.code.slice(0, -6) + (state.code.slice(-6, -4) === '00' ? '01' : '00') + state.code.slice(-4)
    else state.code = compiledRuntime(17)
    await assert.rejects(mod.validateRepresentation({ chain: 'base-mainnet', address, provider, expectedOwner: owner, expectedOrigin: origin }), /runtime bytecode differs/)
    assert.equal(state.getters, 0); assert.equal(state.keys, 0); assert.equal(state.mint, 0)
  })
}
for (const malformed of ['missing runtime', 'odd runtime hex', 'wrong immutable declaration', 'wrong AST identity', 'extra immutable', 'missing refs', 'negative offset', 'overflow offset', 'wrong width', 'overlap', 'unexpected field', 'nonzero placeholder', 'not PUSH32']) {
  test('malformed runtime proof fails closed: ' + malformed, async () => {
    const artifact = JSON.parse(JSON.stringify(mainnetArtifact))
    const ref = artifact.immutableReferences['825'][0]
    if (malformed === 'missing runtime') delete artifact.deployedBytecode
    if (malformed === 'odd runtime hex') artifact.deployedBytecode += '0'
    if (malformed === 'wrong immutable declaration') artifact.immutableBinding.name = '_other'
    if (malformed === 'wrong AST identity') artifact.immutableBinding.astId = 826
    if (malformed === 'extra immutable') artifact.immutableReferences['826'] = [{ length: 32, start: 500 }]
    if (malformed === 'missing refs') artifact.immutableReferences['825'] = []
    if (malformed === 'negative offset') ref.start = -1
    if (malformed === 'overflow offset') ref.start = Number.MAX_SAFE_INTEGER
    if (malformed === 'wrong width') ref.length = 31
    if (malformed === 'overlap') artifact.immutableReferences['825'].push({ ...ref })
    if (malformed === 'unexpected field') ref.mask = true
    if (malformed === 'nonzero placeholder') artifact.deployedBytecode = artifact.deployedBytecode.slice(0, 2 + ref.start * 2) + '01' + artifact.deployedBytecode.slice(4 + ref.start * 2)
    if (malformed === 'not PUSH32') artifact.deployedBytecode = artifact.deployedBytecode.slice(0, 2 + (ref.start - 1) * 2) + '60' + artifact.deployedBytecode.slice(2 + ref.start * 2)
    const { mod, state, provider } = fixture('base-mainnet', artifact)
    assert.throws(() => mod.expectedMainnetRuntime(), /immutable|runtime bytecode/)
    await assert.rejects(mod.validateRepresentation({ chain: 'base-mainnet', address, provider, expectedOwner: owner, expectedOrigin: origin }), /immutable|runtime bytecode/)
    assert.equal(state.getters, 0); assert.equal(state.keys, 0)
  })
}
for (const chain of ['base-mainnet', 'ethereum-mainnet']) {
  test(chain + ' disables automatic managed mint and ownership signing before keys', async () => {
    const { mod, state } = fixture(chain)
    await assert.rejects(mod.deployAndMint({ chain, existingContract: address, recipient, amountToken: '10', srcOrigin: origin }), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
    await assert.rejects(mod.transferOwnershipTo(chain, address, owner, origin), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
    assert.equal(state.keys, 0); assert.equal(state.mint, 0)
    const info = await mod.authorityInfo(chain)
    assert.equal(info.writes_enabled, false); assert.equal(state.keys, 0)
  })
  test(chain + ' burn needs exact amount, canonical block and finalized inclusion', async () => {
    const { mod, state } = fixture(chain)
    assert.equal((await mod.verifyBurn(chain, 'tx', address, '10', origin)).valid, true)
    assert.equal((await mod.verifyBurn(chain, 'tx', address, '9', origin)).valid, false)
    state.finalNumber = 9
    assert.match((await mod.verifyBurn(chain, 'tx', address, '10', origin)).reason, /not finalized/)
    state.finalNumber = 20; state.canonicalHash = '0x' + 'b'.repeat(64)
    assert.match((await mod.verifyBurn(chain, 'tx', address, '10', origin)).reason, /canonical block/)
    state.canonicalHash = blockHash; state.chainId = '0xaa36a7'
    assert.equal((await mod.verifyBurn(chain, 'tx', address, '10', origin)).reason, 'burn verification failed: RPC or representation evidence unavailable')
  })
}
test('representation checks reject absent code, wrong owner, decimals, origin and unreadable owner', async () => {
  for (const changed of [{ code: '0x' }, { owner: recipient }, { decimals: 9n }, { origin: 'bitcoin:acme:OTHER' }, { ownerError: true }]) {
    const { mod, state, provider } = fixture('base')
    Object.assign(state, changed)
    await assert.rejects(mod.validateRepresentation({ chain: 'base', address, provider, expectedOwner: owner, expectedOrigin: origin }))
    assert.equal(state.keys, 0); assert.equal(state.mint, 0)
  }
})
test('owner read failure never falls back to a local legacy signer', async () => {
  const { mod, state } = fixture('base')
  state.ownerError = true
  await assert.rejects(mod.deployAndMint({ chain: 'base', existingContract: address, recipient, amountToken: '10', srcOrigin: origin }), /owner RPC unavailable/)
  assert.equal(state.keys, 0); assert.equal(state.mint, 0)
})
test('mainnet burn rejects unavailable finality or missing source binding', async () => {
  const { mod, state } = fixture()
  assert.equal((await mod.verifyBurn('base-mainnet', 'tx', address, '10')).valid, false)
  state.finalityError = true
  assert.equal((await mod.verifyBurn('base-mainnet', 'tx', address, '10', origin)).reason, 'burn verification failed: RPC or representation evidence unavailable')
})
test('EVM structured burn failures and authority status never expose paid RPC error details', async () => {
  const { mod, provider } = fixture()
  const secret = 'https://paid-rpc.example.invalid/API_KEY_PRIVATE?token=PRIVATE'
  provider.send = async () => { throw Error('upstream request failed at ' + secret) }
  const burn = await mod.verifyBurn('base-mainnet', 'tx', address, '10', origin)
  assert.equal(burn.valid, false)
  assert.equal(burn.reason, 'burn verification failed: RPC or representation evidence unavailable')
  assert.equal(JSON.stringify(burn).includes(secret), false)
  await assert.rejects(mod.authorityInfo('base-mainnet'), error => error.message === 'EVM authority status unavailable' && error.code === 'EVM_STATUS_UNAVAILABLE' && !error.stack.includes(secret))
})
test('Safe public status throws a fixed failure without paid RPC endpoint or key details', async () => {
  const secret = 'https://paid-rpc.example.invalid/API_KEY_PRIVATE?token=PRIVATE'
  const safe = load('safe.js', { ethers: { ethers }, '@safe-global/protocol-kit': {}, fs: {}, path,
    './network-config': { ...networks, evmChain: chain => networks.evmChain(chain, env), CheckedEvmProvider: class { async send() { throw Error('upstream ' + secret) } } } })
  await assert.rejects(safe.info('base-mainnet'), error => error.message === 'Safe status unavailable' && error.code === 'SAFE_STATUS_UNAVAILABLE' && !error.stack.includes(secret))
})
test('EVM signer module loads lazily and rejects mainnet signer access before any key read', async () => {
  let reads = 0
  const signer = load('evm-signer.js', { ethers: { ethers }, '@emblemvault/auth-sdk/signers/ethers': { toEthersWallet: async () => { throw Error('no managed signer access') } },
    fs: { existsSync: () => { reads++; return false }, readFileSync: () => { reads++; throw Error('no key access') } }, path,
    './network-config': networks })
  assert.equal(reads, 0)
  assert.throws(() => signer.signer('base-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  await assert.rejects(signer.emblemSigner('ethereum-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  assert.equal(reads, 0)
})
test('mainnet Safe operations and public status never read local private key files', async () => {
  let reads = 0, signs = 0
  const safe = load('safe.js', { ethers: { ethers }, '@safe-global/protocol-kit': { init: async () => { signs++; throw Error('not allowed') } },
    fs: { readFileSync: () => { reads++; throw Error('no key reads allowed') }, existsSync: () => { reads++; return true } }, path,
    './network-config': { ...networks, evmChain: chain => networks.evmChain(chain, env), CheckedEvmProvider: class { async send() { return '0x2105' } } } })
  for (const call of [() => safe.ensureSafe('base-mainnet'), () => safe.mintViaSafe({ chain: 'base-mainnet' }), () => safe.deployRep({ chain: 'base-mainnet' })])
    await assert.rejects(call(), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  assert.throws(() => safe.ownerAddrs('base-mainnet'), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
  const info = await safe.info('base-mainnet')
  assert.equal(info.writes_enabled, false); assert.equal(info.signer_independence_verified, false)
  assert.equal(reads, 0); assert.equal(signs, 0)
})
