const test = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')
const networks = require('../network-config')

test('persistent EVM identities keep Sepolia distinct from both mainnets', () => {
  assert.equal(networks.EVM_CHAINS.base.chainId, 84532)
  assert.equal(networks.EVM_CHAINS.ethereum.chainId, 11155111)
  assert.equal(networks.EVM_CHAINS['base-mainnet'].chainId, 8453)
  assert.equal(networks.EVM_CHAINS['ethereum-mainnet'].chainId, 1)
  assert.equal(networks.evmChain('base-mainnet', { BASE_MAINNET_RPC: 'https://base.example.invalid/key' }).rpc, 'https://base.example.invalid/key')
})
test('mainnet RPC must be explicit HTTPS and invalid endpoints never fall back', () => {
  for (const value of [undefined, '', 'http://localhost:8545', 'ftp://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/#fragment']) {
    assert.throws(() => networks.evmChain('base-mainnet', { BASE_MAINNET_RPC: value }), /HTTPS/)
  }
  assert.throws(() => networks.evmChain('ethereum-mainnet', {}), /ETH_MAINNET_RPC/)
  assert.throws(() => networks.evmChain('constructor', {}), /unsupported/)
})
test('fresh chainId verification rejects mismatch even if provider metadata claims mainnet', async () => {
  await assert.rejects(networks.assertEvmNetwork({ getNetwork: async () => ({ chainId: 1n }), send: async () => '0xaa36a7' }, 'ethereum-mainnet'), /does not match/)
  await assert.rejects(networks.assertEvmNetwork({ send: async () => { throw Error('offline') } }, 'base-mainnet'), /offline/)
  for (const malformed of [null, true, 1, '1', '0x01', '0x']) assert.throws(() => networks.assertChainId(malformed, 'ethereum-mainnet'), /invalid chain ID/)
})
test('transport gate stops requests after an RPC switches network', async t => {
  const original = ethers.JsonRpcProvider.prototype._send
  let actual = '0x2105', effects = 0
  ethers.JsonRpcProvider.prototype._send = async payload => {
    if (payload.method === 'eth_chainId') return [{ id: payload.id, result: actual }]
    effects++
    return [{ id: payload.id, result: '0x1' }]
  }
  t.after(() => { ethers.JsonRpcProvider.prototype._send = original })
  const rpc = new networks.CheckedEvmProvider('base-mainnet', { BASE_MAINNET_RPC: 'https://example.invalid' })
  t.after(() => rpc.destroy())
  await rpc._send({ jsonrpc: '2.0', id: 10, method: 'eth_getBalance', params: [] })
  actual = '0x14a34'
  await assert.rejects(rpc._send({ jsonrpc: '2.0', id: 11, method: 'eth_sendRawTransaction', params: ['0x00'] }), /does not match/)
  assert.equal(effects, 1)
})
