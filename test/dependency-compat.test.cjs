const test = require('node:test')
const assert = require('node:assert/strict')
const bigint = require('bigint-buffer')
const layout = require('@solana/buffer-layout-utils')
const { MintLayout, AccountLayout } = require('@solana/spl-token')
const { Connection, PublicKey } = require('@solana/web3.js')
const bip = require('bip322-js')
const bitcoin = require('bitcoinjs-lib')
const key = require('ecpair').ECPairFactory(require('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 7))
test('pure-JS adapter matches unsigned integer vectors in both byte orders', () => {
  assert.equal(require('bigint-buffer/package.json').name, '@stampyswap/bigint-buffer')
  for (const bits of [64, 128, 192, 256]) {
    for (const value of [0n, 1n, 255n, 256n, (1n << BigInt(bits)) - 1n]) {
      const width = bits / 8
      const expected = value.toString(16).padStart(width * 2, '0')
      assert.equal(bigint.toBufferBE(value, width).toString('hex'), expected)
      assert.equal(bigint.toBufferLE(value, width).toString('hex'), Buffer.from(expected, 'hex').reverse().toString('hex'))
      const be = Buffer.from(expected, 'hex'), le = Buffer.from(be).reverse()
      assert.equal(layout['u' + bits + 'be']().decode(be), value)
      assert.equal(layout['u' + bits]().decode(le), value)
      const buffer = Buffer.alloc(width); layout['u' + bits]().encode(value, buffer, 0)
      assert.deepEqual(buffer, le)
    }
  }
})
test('adapter rejects oversized widths, negative values and integer overflow', () => {
  for (const [value, width] of [[-1n, 8], [1n << 64n, 8], [1n, 0], [0n, -1], [0n, 4097], [0n, 1.5], [1, 8]]) assert.throws(() => bigint.toBufferLE(value, width))
  assert.equal(bigint.toBufferLE(0n, 0).length, 0)
  assert.equal(bigint.toBigIntLE(Buffer.alloc(0)), 0n)
  assert.throws(() => bigint.toBigIntBE(Buffer.alloc(4097)))
})
test('SPL mint and token-account decode preserve the full unsigned-64-bit supply', () => {
  const max = (1n << 64n) - 1n, mint = Buffer.alloc(MintLayout.span), account = Buffer.alloc(AccountLayout.span)
  mint.writeBigUInt64LE(max, 36); mint[44] = 9; mint[45] = 1
  account.writeBigUInt64LE(max, 64)
  assert.equal(MintLayout.decode(mint).supply, max)
  assert.equal(MintLayout.decode(mint).decimals, 9)
  assert.equal(AccountLayout.decode(account).amount, max)
})
test('upgraded JSON-RPC client round-trips Solana request IDs and propagates server errors', async () => {
  let fail = false, seen = []
  const connection = new Connection('https://offline.invalid', { httpAgent: false, fetch: async (_, init) => {
    const request = JSON.parse(init.body); seen.push(request)
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(fail ? { error: { code: -32000, message: 'offline test failure' } } : { result: { context: { slot: 1 }, value: 12345 } }) }) }
  } })
  const address = new PublicKey(Buffer.alloc(32, 1))
  assert.equal(await connection.getBalance(address), 12345)
  assert.equal(seen[0].method, 'getBalance'); assert.equal(seen[0].params[0], address.toBase58())
  assert.equal(typeof seen[0].id, 'string')
  fail = true
  await assert.rejects(connection.getBalance(address), /offline test failure/)
  assert.notEqual(seen[0].id, seen[1].id)
})
test('BIP-322 upgrade signs and verifies P2WPKH and rejects a changed message or address', () => {
  const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey) }).address
  const other = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 8) }).address
  const message = 'StampySwap compatibility test', signature = bip.Signer.sign(key.toWIF(), address, message)
  assert.equal(typeof signature, 'string')
  assert.equal(bip.Verifier.verifySignature(address, message, signature), true)
  assert.equal(bip.Verifier.verifySignature(address, message + ' changed', signature), false)
  assert.equal(bip.Verifier.verifySignature(other, message, signature), false)
})
