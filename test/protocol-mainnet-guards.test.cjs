const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { ethers } = require('ethers')
const networks = require('../network-config')
const ROOT = path.join(__dirname, '..')
const from = '0x' + '1'.repeat(40), tokenA = '0x' + '2'.repeat(40), tokenB = '0x' + '3'.repeat(40)
function fixture() {
  const effects = { keys: 0, provider: 0, serialize: 0, staticCalls: 0 }
  const rpc = { send: async method => { assert.equal(method, 'eth_chainId'); return '0x2105' } }
  const signer = { get address() { effects.keys++; throw Error('private fee key must not be read') },
    signer() { effects.keys++; throw Error('raw signer must not be read') },
    emblemSigner() { effects.keys++; throw Error('managed signer must not be read') },
    emblemAddress() { effects.keys++; throw Error('managed signer address must not be requested') },
    serialize() { effects.serialize++; throw Error('testnet serialization reached') },
    provider() { effects.provider++; return rpc } }
  const mockEthers = { ...ethers, Contract: function (_address, _abi, runner) {
    assert.equal(runner, rpc)
    return { decimals: async () => 18n, getAmountsOut: async amount => [amount, amount * 2n],
      addLiquidity: { staticCall: async (...args) => { assert.equal(args.at(-1).from, from); effects.staticCalls++ } },
      swapExactTokensForTokens: { staticCall: async (...args) => { assert.equal(args.at(-1).from, from); effects.staticCalls++ } } }
  } }
  function load(file) {
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { module, exports: module.exports, require: name => {
      if (name === 'ethers') return { ethers: mockEthers }
      if (name === './evm-signer') return signer
      if (name === './network-config') return networks
      if (name.startsWith('./') && name.endsWith('.json')) return require(path.join(ROOT, name))
      throw Error('unexpected dependency ' + name)
    }, Date })
    return module.exports
  }
  return { amm: load('amm.js'), uniswap: load('uniswap.js'), effects }
}
test('AMM and Uniswap imports do not read a key or contact the network', () => {
  const { amm, effects } = fixture()
  assert.equal(typeof Object.getOwnPropertyDescriptor(amm, 'deployerAddress').get, 'function')
  assert.deepEqual(effects, { keys: 0, provider: 0, serialize: 0, staticCalls: 0 })
})
for (const chain of ['base-mainnet', 'ethereum-mainnet']) {
  test(chain + ' rejects every protocol-funded AMM/Uniswap financial entry before any effect', async () => {
    const { amm, uniswap, effects } = fixture()
    for (const call of [
      () => amm.deployPair(chain, tokenA, tokenB),
      () => amm.addLiquidity(chain, tokenA, tokenA, tokenB, '1', '1'),
      () => amm.deployExternalToken(chain, 'Demo', 'DEMO', '1'),
      () => amm.swap(chain, tokenA, tokenB, '1', from),
      () => uniswap.addLiquidity(chain, tokenA, tokenB, '1', '1'),
      () => uniswap.swap(chain, '1', tokenA, tokenB),
    ]) await assert.rejects(call(), { code: 'INDEPENDENT_SIGNING_REQUIRED' })
    assert.equal(await amm.lpAddress(chain), null)
    assert.equal(await uniswap.lpAddress(chain), null)
    assert.deepEqual(effects, { keys: 0, provider: 0, serialize: 0, staticCalls: 0 })
  })
}
test('Uniswap public quotes and explicit-owner preflights remain read-only', async () => {
  const { uniswap, effects } = fixture()
  assert.equal(await uniswap.quoteOut('base-mainnet', '1', tokenA, tokenB), '2.0')
  assert.equal((await uniswap.addLiquidity('base-mainnet', tokenA, tokenB, '1', '1', { preflight: true, from })).ok, true)
  assert.equal((await uniswap.swap('base-mainnet', '1', tokenA, tokenB, { preflight: true, from })).ok, true)
  assert.equal(effects.staticCalls, 2)
  assert.equal(effects.keys, 0); assert.equal(effects.serialize, 0)
})
test('preflight omission of public caller never falls back to a managed signer', async () => {
  const { uniswap, effects } = fixture()
  await assert.rejects(uniswap.addLiquidity('base-mainnet', tokenA, tokenB, '1', '1', { preflight: true }), /explicit public from/)
  await assert.rejects(uniswap.swap('base-mainnet', '1', tokenA, tokenB, { preflight: true }), /explicit public from/)
  assert.equal(effects.keys, 0); assert.equal(effects.provider, 0)
})
test('Sepolia AMM operations retain their existing serialization entry', async () => {
  const { amm, effects } = fixture()
  await assert.rejects(amm.deployPair('base', tokenA, tokenB), /testnet serialization reached/)
  assert.equal(effects.serialize, 1)
})
