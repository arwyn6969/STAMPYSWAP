'use strict'
// No keys, signatures or transactions are generated here. The positive fixture is
// a previously published redemption and its existing witness, reconstructed from
// saved public chain observations and checked against both original txids.
const test = require('node:test')
const assert = require('node:assert/strict')
const bitcoin = require('bitcoinjs-lib')
const fixture = require('./fixtures/counterparty-public-redemption.json')
const validator = require('../counterparty-validator')
const counterparty = require('../counterparty')
const { load } = require('./audit-b.fixture.cjs')
const signed = bitcoin.Transaction.fromHex(fixture.transaction), previous = bitcoin.Transaction.fromHex(fixture.previous)
const foreignScript = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).output
function make(options = {}) {
  const psbt = new bitcoin.Psbt().setVersion(options.version === undefined ? signed.version : options.version).setLocktime(options.locktime || 0)
  const input = signed.ins[0]
  psbt.addInput({ hash: input.hash, index: options.index === undefined ? input.index : options.index,
    sequence: options.sequence === undefined ? input.sequence : options.sequence,
    ...(options.declared ? { witnessUtxo: { script: options.inputScript || previous.outs[input.index].script, value: options.inputValue === undefined ? previous.outs[input.index].value : options.inputValue } } : {}),
    ...(options.sighash === undefined ? {} : { sighashType: options.sighash }),
  })
  for (const output of options.outputs || signed.outs) psbt.addOutput(output)
  return { psbtBase64: psbt.toBase64(), from: fixture.from, toAddress: fixture.toAddress, asset: fixture.asset, qtyBase: fixture.qtyBase, ...options.params }
}
const lookup = async () => ({ ok: true, text: async () => fixture.previous })
function changedPlain(offset, before, after) {
  // ARC4 is XOR: mutate a known public plaintext byte without introducing a test
  // encoder that could duplicate the validator's interpretation of the protocol.
  const data = Buffer.from(bitcoin.script.decompile(signed.outs[0].script)[1])
  data[offset] ^= before ^ after
  return [{ script: bitcoin.payments.embed({ data: [data] }).output, value: 0 }, signed.outs[1]]
}

test('public Counterparty redemption proves payload, prevout, fee and existing vault signature', async () => {
  const validated = await validator.validateTransfer(make(), lookup)
  assert.equal(validated.payload.assetId, 187425162n)
  assert.equal(validated.payload.quantity, 10000000n)
  assert.equal(validated.fee, fixture.fee)
  assert.equal(validator.validateSigned(validated, fixture.transaction), signed.getId())
  assert(validated.psbt.data.inputs[0].witnessUtxo.script.equals(previous.outs[4].script))
  assert.equal(validated.psbt.data.inputs[0].witnessUtxo.value, previous.outs[4].value)
  assert.deepEqual(validated.toSignInputs, [{ index: 0, address: fixture.from, sighashType: 1 }])
})
const malformed = [
  ['other protocol prefix', changedPlain(0, 0x43, 0x5a), /not the supported/],
  ['other message type', changedPlain(8, 2, 4), /not the supported/],
  ['additional CBOR field', changedPlain(9, 0x84, 0x85), /exactly four/],
  ['indefinite CBOR array', changedPlain(9, 0x84, 0x9f), /unsupported or truncated/],
  ['negative quantity', changedPlain(15, 0x1a, 0x3a), /CBOR type/],
  ['floating quantity', changedPlain(15, 0x1a, 0xfa), /CBOR type/],
  ['nonempty unsupported memo', changedPlain(42, 0x40, 0x41), /byte string/],
  ['other asset', changedPlain(14, 0x8a, 0x8b), /asset mismatch/],
  ['other exact quantity', changedPlain(19, 0x80, 0x81), /quantity mismatch/],
  ['other recipient', changedPlain(41, 0x72, 0x73), /recipient mismatch/],
  ['foreign change', [signed.outs[0], { ...signed.outs[1], script: foreignScript }], /unapproved change/],
  ['additional Bitcoin payment', [...signed.outs, { script: foreignScript, value: 333 }], /input\/output count/],
  ['nonzero data payment', [{ ...signed.outs[0], value: 333 }, signed.outs[1]], /zero-value OP_RETURN/],
  ['out-of-order data', [signed.outs[1], signed.outs[0]], /first output/],
]
for (const [name, outputs, error] of malformed) test('rejects ' + name + ' directly from the transaction bytes', () => {
  assert.throws(() => validator.parseIntent(make({ outputs })), error)
})
test('trailing ciphertext is rejected even if all intended fields match', () => {
  const data = Buffer.concat([bitcoin.script.decompile(signed.outs[0].script)[1], Buffer.from([0])])
  assert.throws(() => validator.parseIntent(make({ outputs: [{ script: bitcoin.payments.embed({ data: [data] }).output, value: 0 }, signed.outs[1]] })), /trailing bytes/)
})
test('numeric/subasset mappings and BTC sends remain unsupported rather than inferred from metadata', () => {
  for (const asset of ['BTC', 'A1234567890123456789', 'PARENT.child', 'pudsec']) assert.throws(() => validator.parseIntent(make({ params: { asset } })), /asset identity/)
  assert.equal(validator.assetId('XCP'), 1n)
})
test('base-unit amounts reject unsafe numbers, zero, exponent, overflow and precision loss', () => {
  for (const amount of [0, 1, '0', '1e7', '01', '9223372036854775808']) assert.throws(() => validator.parseIntent(make({ params: { qtyBase: amount } })))
  assert.equal(counterparty.releaseQuantity('0.10000000', 8, '10000000'), '10000000')
  assert.equal(counterparty.releaseQuantity('1', 0, '1'), '1')
  for (const args of [[1, 8], ['1e3', 8], ['-1', 8], ['0.1', 0], ['0.000000001', 8], ['1', 7], ['1', 8, '99999999']]) assert.throws(() => counterparty.releaseQuantity(...args))
})
test('hash-bound previous outputs override no composer declarations and cannot be forged', async () => {
  await assert.rejects(validator.validateTransfer(make({ declared: true, inputValue: previous.outs[4].value + 1 }), lookup), /value\/script mismatch/)
  await assert.rejects(validator.validateTransfer(make({ index: 0 }), lookup), /not vault-owned/)
  await assert.rejects(validator.validateTransfer(make(), async () => ({ ok: true, text: async () => fixture.transaction })), /hash mismatch/)
  await assert.rejects(validator.validateTransfer(make(), async () => ({ ok: false })), /lookup failed/)
})
test('oversized streamed previous transactions are cancelled before buffering or parsing', async () => {
  let cancelled = 0, reads = 0
  await assert.rejects(validator.validateTransfer(make(), async () => ({ ok: true, body: {
    getReader: () => ({ read: async () => { reads++; return { done: false, value: Buffer.alloc(500001, 0x30) } }, cancel: async () => { cancelled++ }, releaseLock() {} }),
  } })), /body exceeds size policy/)
  assert.equal(cancelled, 1); assert.equal(reads, 1)
})
test('unsafe signing metadata and relative locks are rejected before external lookups', () => {
  assert.throws(() => validator.parseIntent(make({ sighash: 0x81 })), /sighash/)
  assert.throws(() => validator.parseIntent(make({ declared: true, inputScript: foreignScript })), /not vault-owned/)
  assert.throws(() => validator.parseIntent(make({ locktime: 123 })), /locktime/)
  assert.throws(() => validator.parseIntent(make({ sequence: 1 })), /sequence/)
})
test('absolute and conservative rate fee caps cannot be enlarged by configuration', async () => {
  await assert.rejects(validator.validateTransfer(make({ params: { env: { CP_MAX_FEE_SATS: '481' } } }), lookup), /miner fee/)
  await assert.rejects(validator.validateTransfer(make({ params: { env: { CP_MAX_FEE_RATE: '1' } } }), lookup), /fee rate/)
  await assert.rejects(validator.validateTransfer(make({ params: { env: { CP_MAX_FEE_SATS: '50001' } } }), lookup), /invalid or excessive/)
  await assert.rejects(validator.validateTransfer(make({ params: { env: { CP_MAX_FEE_RATE: 'NaN' } } }), lookup), /invalid or excessive/)
  await assert.rejects(validator.validateTransfer(make({ outputs: [signed.outs[0], { ...signed.outs[1], value: previous.outs[4].value + 1 }] }), lookup), /outputs exceed inputs/)
})
test('changed signed bytes, sighash and signature fail independently before broadcast', async () => {
  const validated = await validator.validateTransfer(make(), lookup)
  const changed = bitcoin.Transaction.fromHex(fixture.transaction); changed.outs[1].value++
  assert.throws(() => validator.validateSigned(validated, changed.toHex()), /changed the transaction/)
  const flag = bitcoin.Transaction.fromHex(fixture.transaction); flag.ins[0].witness[0][flag.ins[0].witness[0].length - 1] = 0x81
  assert.throws(() => validator.validateSigned(validated, flag.toHex()), /sighash/)
  const signature = bitcoin.Transaction.fromHex(fixture.transaction); signature.ins[0].witness[0][10] ^= 1
  assert.throws(() => validator.validateSigned(validated, signature.toHex()), /invalid vault signature/)
})

function custodyHarness(options = {}) {
  const effects = { remote: 0, vaultReads: 0, signerAccess: 0, signed: 0, broadcast: 0, inputs: null }
  const fetchFixture = async (url, request) => {
    effects.remote++
    if (url.includes('/compose/send')) {
      const u = new URL(url)
      assert.equal(u.searchParams.get('encoding'), 'opreturn')
      assert.equal(u.searchParams.get('use_enhanced_send'), 'true')
      assert.equal(u.searchParams.get('quantity'), fixture.qtyBase)
      return { ok: true, text: async () => JSON.stringify({ result: {
        psbt: options.psbtBase64 || make().psbtBase64,
        // Deliberately forged metadata: only transaction bytes and proven prevouts count.
        params: { asset: 'UNTRUSTED', destination: 'untrusted', quantity: '0' },
        lock_scripts: [foreignScript.toString('hex')], inputs_values: ['9999999999999'],
      } }) }
    }
    if (request?.method === 'POST') { effects.broadcast++; return { ok: options.broadcastOk !== false, text: async () => options.broadcastTxid || signed.getId() } }
    return lookup()
  }
  const cp = load('counterparty.js', () => { throw Error('unexpected CP import') }, { fetch: fetchFixture }).exports
  const acme = load('acme.js', () => { throw Error('unexpected ACME import') }, { fetch: fetchFixture }).exports
  const custody = load('custody.js', name => {
    if (name === '@emblemvault/auth-sdk/signers/bitcoin') return {
      fetchBitcoinVaultInfo: async () => { effects.vaultReads++; return { btcAddresses: { p2wpkh: fixture.from } } },
      toBitcoinSigner: async () => { effects.signerAccess++; return { signPsbt: async (hex, config) => {
        effects.signed++; effects.inputs = config.toSignInputs
        const hydrated = bitcoin.Psbt.fromHex(hex)
        assert.equal(hydrated.data.inputs[0].witnessUtxo.value, previous.outs[4].value)
        assert(hydrated.data.inputs[0].witnessUtxo.script.equals(previous.outs[4].script))
        return { signedTxHex: options.signedHex || fixture.transaction }
      } } },
    }
    if (name === 'fs') return { existsSync: () => false }
    if (name === './counterparty') return cp
    if (name === './counterparty-validator') return validator
    if (name === './acme') return acme
    if (name === './src20-validator') return require('../src20-validator')
    return require(name)
  }, { process: { env: { STAMPY_CUSTODY_LIVE: '1', ...options.env } }, fetch: fetchFixture }).exports
  const redeem = extra => custody.redeem({ protocol: 'counterparty', tick: fixture.asset, amount: fixture.amountWhole,
    qtyBase: fixture.qtyBase, dec: fixture.dec, toAddress: fixture.toAddress, ...extra })
  return { custody, redeem, effects }
}
test('custody ignores forged composer metadata and signs only independently validated inputs', async () => {
  const f = custodyHarness()
  assert.equal((await f.redeem()).txid, signed.getId())
  assert.equal(f.effects.signed, 1); assert.equal(f.effects.broadcast, 1)
  assert.deepEqual(Array.from(f.effects.inputs, item => ({ ...item })), [{ index: 0, address: fixture.from, sighashType: 1 }])
})
test('honest-looking composer params cannot authorize different payload bytes', async () => {
  const f = custodyHarness({ psbtBase64: make({ outputs: changedPlain(19, 0x80, 0x81) }).psbtBase64 })
  await assert.rejects(f.redeem(), /payload quantity mismatch/)
  assert.equal(f.effects.signerAccess, 0); assert.equal(f.effects.signed, 0); assert.equal(f.effects.broadcast, 0)
})
test('custody refuses a changed signer transaction before its mocked broadcast', async () => {
  const changed = bitcoin.Transaction.fromHex(fixture.transaction); changed.outs[1].value++
  const f = custodyHarness({ signedHex: changed.toHex() })
  await assert.rejects(f.redeem(), /changed the transaction/)
  assert.equal(f.effects.signed, 1); assert.equal(f.effects.broadcast, 0)
})
test('custody never claims a successful release for failed/mismatched broadcast acknowledgement', async () => {
  for (const options of [{ broadcastOk: false }, { broadcastTxid: 'aa'.repeat(32) }]) {
    const f = custodyHarness(options)
    await assert.rejects(f.redeem(), /broadcast response/)
    assert.equal(f.effects.broadcast, 1)
  }
})
test('authoritative source quantity disagreement is refused before custody or composer access', async () => {
  const f = custodyHarness()
  await assert.rejects(f.redeem({ qtyBase: '9999999' }), /authorized amount/)
  assert.equal(f.effects.remote, 0); assert.equal(f.effects.vaultReads, 0); assert.equal(f.effects.signed, 0)
})
test('ACME release fails closed before every remote/key/signer effect even when custody is live', async () => {
  const f = custodyHarness({ env: { ACME_ENV_V1: 'ignored', ACME_ENV_V2: 'ignored', ACME_FEE_ADDRESS: fixture.toAddress } })
  await assert.rejects(f.redeem({ protocol: 'acme' }), { code: 'ACME_RELEASE_VALIDATION_REQUIRED' })
  assert.equal(f.effects.remote, 0); assert.equal(f.effects.vaultReads, 0); assert.equal(f.effects.signerAccess, 0)
  assert.equal(f.effects.signed, 0); assert.equal(f.effects.broadcast, 0)
})
test('Counterparty composer response is cancelled at its streamed JSON size bound', async () => {
  let cancelled = 0, reads = 0
  const cp = load('counterparty.js', () => { throw Error('unexpected import') }, { fetch: async () => ({ ok: true, body: {
    getReader: () => ({ read: async () => { reads++; return { done: false, value: Buffer.alloc(1000001, 0x20) } }, cancel: async () => { cancelled++ }, releaseLock() {} }),
  } }) }).exports
  await assert.rejects(cp.composeSend({ from: fixture.from, toAddress: fixture.toAddress, asset: fixture.asset, qtyWhole: fixture.amountWhole, dec: fixture.dec }), /response exceeds size policy/)
  assert.equal(cancelled, 1); assert.equal(reads, 1)
})
