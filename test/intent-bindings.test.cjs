'use strict'
// Fixed public fixture keys only. Pure message/signature checks; no chain or vault calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')
const bip = require('bip322-js')
const bitcoin = require('bitcoinjs-lib')
const btcKey = require('ecpair').ECPairFactory(require('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 7))
const btcSource = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(btcKey.publicKey) }).address
const nacl = require('tweetnacl')
const bindings = require('../intent-bindings')
const owner = new ethers.Wallet('0x' + '1'.repeat(64))
const asset = { source_protocol: 'src-20', exact_ticker: 'COIN', deploy_tx: 'deploy' }
const common = { group: 'kevmart', asset, vault: 'vault', amount: '10' }
const deposit = { ...common, sourceAddress: btcSource, depositTxid: 'deposit', destinationChain: 'base-mainnet', destinationAddress: owner.address }
const redeem = { ...common, sourceChain: 'base-mainnet', representation: 'representation', burnTxid: 'burn', destinationAddress: btcSource }
const move = { ...common, sourceChain: 'base-mainnet', representation: 'representation', burnTxid: 'burn', destinationChain: 'ethereum-mainnet', destinationAddress: owner.address }
const verifiesBtc = (message, signature) => { try { return bip.Verifier.verifySignature(btcSource, message, signature) } catch (_) { return false } }

test('v1 messages have an independently specified application, action and exact identity structure', () => {
  const signed = bindings.depositMessage(deposit)
  assert.ok(signed.startsWith('StampySwap authorization v1\n'))
  assert.deepEqual(JSON.parse(signed.split('\n').slice(1).join('\n')), {
    version: 1, action: 'deposit', domain: { application: 'StampySwap', group: 'kevmart' },
    asset: { chain: 'bitcoin-mainnet', protocol: 'src-20', ticker: 'COIN', deploy_identity: 'deploy' },
    custody: { chain: 'bitcoin-mainnet', vault: 'vault' },
    source: { chain: 'bitcoin-mainnet', address: btcSource, txid: 'deposit' },
    destination: { chain: 'base-mainnet', address: owner.address }, amount: '10'
  })
  assert.equal(bindings.depositMessage({ ...deposit, amount: '00010.000' }), signed)
})

const commonChanges = [
  ['application group', { group: 'another-app-group' }],
  ['custody vault', { vault: 'another-vault' }],
  ['source protocol', { asset: { ...asset, source_protocol: 'counterparty' } }],
  ['exact ticker', { asset: { ...asset, exact_ticker: '$COIN' } }],
  ['deploy identity', { asset: { ...asset, deploy_tx: 'another-deploy' } }],
  ['exact amount', { amount: '11' }]
]
const cases = [
  ['deposit', deposit, bindings.depositMessage, [
    ['deposit source', { sourceAddress: 'another-source' }], ['deposit transaction', { depositTxid: 'another-deposit' }],
    ['mint chain', { destinationChain: 'solana-mainnet' }], ['mint recipient', { destinationAddress: 'another-recipient' }]
  ]],
  ['redeem', redeem, bindings.redeemMessage, [
    ['burn chain', { sourceChain: 'ethereum-mainnet' }], ['source representation', { representation: 'another-representation' }],
    ['burn transaction', { burnTxid: 'another-burn' }], ['Bitcoin release recipient', { destinationAddress: 'another-recipient' }]
  ]],
  ['move', move, bindings.moveMessage, [
    ['burn chain', { sourceChain: 'solana-mainnet' }], ['source representation', { representation: 'another-representation' }],
    ['burn transaction', { burnTxid: 'another-burn' }], ['mint chain', { destinationChain: 'solana-mainnet' }],
    ['mint recipient', { destinationAddress: 'another-recipient' }]
  ]]
]
for (const [action, values, build, changes] of cases) {
  test(action + ' signatures reject every substituted intent field', async () => {
    const original = build(values)
    const signature = action === 'deposit' ? bip.Signer.sign(btcKey.toWIF(), btcSource, original) : await owner.signMessage(original)
    for (const [field, change] of [...commonChanges, ...changes]) {
      const substituted = build({ ...values, ...change })
      assert.notEqual(substituted, original, field)
      if (action === 'deposit') assert.equal(verifiesBtc(substituted, signature), false, field)
      else assert.notEqual(ethers.verifyMessage(substituted, signature), owner.address, field)
    }
  })
}

test('one Bitcoin deposit signature cannot select another of the three mainnets', () => {
  const chains = ['solana-mainnet', 'base-mainnet', 'ethereum-mainnet']
  for (const destinationChain of chains) {
    const original = bindings.depositMessage({ ...deposit, destinationChain })
    const signature = bip.Signer.sign(btcKey.toWIF(), btcSource, original)
    assert.equal(verifiesBtc(original, signature), true)
    for (const substitutedChain of chains.filter(chain => chain !== destinationChain))
      assert.equal(verifiesBtc(bindings.depositMessage({ ...deposit, destinationChain: substitutedChain }), signature), false)
  }
})

test('Solana burn-owner signatures also bind source chain and representation', () => {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8))
  const original = bindings.redeemMessage({ ...redeem, sourceChain: 'solana-mainnet' })
  const signature = nacl.sign.detached(new TextEncoder().encode(original), key.secretKey)
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode(original), signature, key.publicKey), true)
  for (const change of [{ sourceChain: 'ethereum-mainnet' }, { representation: 'other-mint' }])
    assert.equal(nacl.sign.detached.verify(new TextEncoder().encode(bindings.redeemMessage({ ...redeem, sourceChain: 'solana-mainnet', ...change })), signature, key.publicKey), false)
})

test('JSON encoding preserves arbitrary exact tickers without delimiter ambiguity', () => {
  const ticker = ' COIN\n"destination": {"chain":"ethereum-mainnet"} '
  const message = bindings.depositMessage({ ...deposit, asset: { ...asset, exact_ticker: ticker } })
  const parsed = JSON.parse(message.slice(message.indexOf('\n') + 1))
  assert.equal(parsed.asset.ticker, ticker)
  assert.equal(parsed.destination.chain, 'base-mainnet')
})

test('incomplete identities and inexact amounts cannot produce a signable challenge', () => {
  for (const change of [{ group: '' }, { vault: '' }, { depositTxid: '' }, { sourceAddress: '' },
    { destinationChain: 'mainnet' }, { asset: { ...asset, deploy_tx: null } }, { asset: { ...asset, source_protocol: '' } }])
    assert.throws(() => bindings.depositMessage({ ...deposit, ...change }))
  for (const amount of [10, '0', '-1', 'NaN', '1e3', '1.0000000000000000001'])
    assert.throws(() => bindings.depositMessage({ ...deposit, amount }))
  assert.throws(() => bindings.moveMessage({ ...move, destinationChain: move.sourceChain }))
})
