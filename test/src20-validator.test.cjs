const test = require('node:test')
const assert = require('node:assert/strict')
const bitcoin = require('bitcoinjs-lib')
const fixture = require('./fixtures/src20-public-redemption.json')
const { parseIntent, validateTransfer, validateSigned } = require('../src20-validator')
const { load } = require('./audit-b.fixture.cjs')
const signed = bitcoin.Transaction.fromHex(fixture.transaction)
const previous = bitcoin.Transaction.fromHex(fixture.previous)
const from = fixture.indexed.creator, toAddress = fixture.indexed.destination
const payload = { p: 'SRC-20', op: 'TRANSFER', tick: '$bald', amt: '1000' }
function dataOutputs(text = JSON.stringify(payload), prefix = 'stamp:', padding = 0) {
  const body = Buffer.from(prefix + text), length = Buffer.alloc(2)
  length.writeUInt16BE(body.length)
  const data = Buffer.concat([length, body, Buffer.alloc((32 - (body.length + 2) % 32) % 32, padding)])
  return Array.from({ length: data.length / 32 }, (_, i) => ({ value: 333, script: Buffer.concat([Buffer.from([0, 32]), data.subarray(i * 32, i * 32 + 32)]) }))
}
function make(options = {}) {
  const p = new bitcoin.Psbt().setVersion(signed.version).setLocktime(signed.locktime)
  p.addInput({ hash: options.hash || signed.ins[0].hash, index: 0, sequence: signed.ins[0].sequence,
    witnessUtxo: { script: options.inputScript || previous.outs[0].script, value: options.inputValue === undefined ? previous.outs[0].value : options.inputValue },
    ...(options.sighash === undefined ? {} : { sighashType: options.sighash }) })
  const outputs = options.outputs || [signed.outs[0], ...(options.data || signed.outs.slice(1, -1)), signed.outs.at(-1)]
  for (const output of outputs) p.addOutput(output)
  return { psbtHex: p.toHex(), from, toAddress, tick: '$BALD', amount: '1000', ...options.params }
}
const lookup = async () => ({ ok: true, text: async () => fixture.previous })
test('public indexed OLGA redemption independently decodes and verifies its real vault signature', async () => {
  const result = await validateTransfer(make(), lookup)
  assert.equal(result.fee, fixture.indexed.fee)
  assert.equal(result.payload.tick, fixture.indexed.tick)
  assert.equal(result.payload.amt, '1000')
  assert.equal(validateSigned(result, fixture.transaction), signed.getId())
  assert.deepEqual(result.toSignInputs, [{ index: 0, address: from, sighashType: 1 }])
})
test('equal decimal quantities compare without floating-point rounding', async () => {
  const result = await validateTransfer(make({ data: dataOutputs(JSON.stringify({ ...payload, amt: '1000.000000000000000001' })), params: { amount: '1000.000000000000000001' } }), lookup)
  assert.equal(result.payload.amt, '1000.000000000000000001')
  assert.throws(() => parseIntent(make({ params: { amount: '1000.000000000000000002' } })), /amount mismatch/)
})
const invalid = [
  ['other token', { data: dataOutputs(JSON.stringify({ ...payload, tick: 'OTHER' })) }, /ticker mismatch/],
  ['other amount', { data: dataOutputs(JSON.stringify({ ...payload, amt: '1001' })) }, /amount mismatch/],
  ['mint operation', { data: dataOutputs(JSON.stringify({ ...payload, op: 'MINT' })) }, /not an SRC-20 TRANSFER/],
  ['other protocol', { data: dataOutputs(JSON.stringify({ ...payload, p: 'SRC-721' })) }, /not an SRC-20 TRANSFER/],
  ['extra semantic fields', { data: dataOutputs(JSON.stringify({ ...payload, holders_of: 'OTHER' })) }, /unexpected transfer fields/],
  ['duplicate keys', { data: dataOutputs('{"p":"SRC-20","op":"MINT","op":"TRANSFER","tick":"$bald","amt":"1000"}') }, /noncanonical/],
  ['numeric amount', { data: dataOutputs(JSON.stringify({ ...payload, amt: 1000 })) }, /invalid transfer amount/],
  ['exponent amount', { data: dataOutputs(JSON.stringify({ ...payload, amt: '1e3' })) }, /invalid transfer amount/],
  ['nonzero padding', { data: dataOutputs(JSON.stringify(payload), 'stamp:', 1) }, /padding/],
  ['wrong stamp prefix', { data: dataOutputs(JSON.stringify(payload), 'other:') }, /prefix/],
  ['unrelated OP_RETURN', { data: [{ script: bitcoin.payments.embed({ data: [Buffer.from('not SRC20')] }).output, value: 0 }] }, /missing OLGA/],
  ['recipient in wrong output position', { outputs: [signed.outs[1], signed.outs[0], ...signed.outs.slice(2)] }, /first output/],
  ['external change', { outputs: [...signed.outs.slice(0, -1), { ...signed.outs.at(-1), script: signed.outs[0].script }] }, /change destination/],
  ['extra foreign output', { outputs: [...signed.outs, signed.outs[0]] }, /unexpected output/],
  ['excessive recipient value', { outputs: [{ ...signed.outs[0], value: 1001 }, ...signed.outs.slice(1)] }, /dust policy/],
  ['unsafe sighash', { sighash: 0x81 }, /sighash/],
  ['non-vault declared input', { inputScript: signed.outs[0].script }, /declared vault/],
  ['invalid cap', { params: { env: { SRC20_MAX_NONVAULT_SATS: 'NaN' } } }, /invalid or excessive/],
  ['bypass cap', { params: { env: { SRC20_MAX_NONVAULT_SATS: '999999999' } } }, /invalid or excessive/],
]
for (const [name, options, error] of invalid) test('rejects ' + name, () => assert.throws(() => parseIntent(make(options)), error))
test('forged witness UTXO value is checked against the hash-bound previous transaction', async () => {
  await assert.rejects(validateTransfer(make({ inputValue: 50001 }), lookup), /ownership or value mismatch/)
})
test('a wrong previous transaction cannot establish input value', async () => {
  await assert.rejects(validateTransfer(make(), async () => ({ ok: true, text: async () => fixture.transaction })), /hash mismatch/)
})
test('a failed previous transaction lookup fails closed', async () => {
  await assert.rejects(validateTransfer(make(), async () => ({ ok: false })), /lookup failed/)
})
test('a high fee funded by a real verified vault output is rejected', async () => {
  await assert.rejects(validateTransfer(make({ outputs: [...signed.outs.slice(0, -1), { ...signed.outs.at(-1), value: 333 }], params: { env: { SRC20_MAX_FEE_SATS: '10000' } } }), lookup), /miner fee/)
})
test('unsafe signer sighash and invalid signatures are rejected independently', async () => {
  const result = await validateTransfer(make(), lookup)
  const badFlag = bitcoin.Transaction.fromHex(fixture.transaction)
  badFlag.ins[0].witness[0][badFlag.ins[0].witness[0].length - 1] = 0x81
  assert.throws(() => validateSigned(result, badFlag.toHex()), /sighash/)
  const badSignature = bitcoin.Transaction.fromHex(fixture.transaction)
  badSignature.ins[0].witness[0][10] ^= 1
  assert.throws(() => validateSigned(result, badSignature.toHex()), /invalid vault signature/)
  const changed = bitcoin.Transaction.fromHex(fixture.transaction)
  changed.outs[0].value++
  assert.throws(() => validateSigned(result, changed.toHex()), /changed the transaction/)
})
function custodyHarness(options = {}) {
  const effects = { signed: 0, broadcast: 0, inputs: null }
  const result = load('custody.js', name => {
    if (name === '@emblemvault/auth-sdk/signers/bitcoin') return {
      fetchBitcoinVaultInfo: async () => ({ btcAddresses: { p2wpkh: from } }),
      toBitcoinSigner: async () => ({ signPsbt: async (_, config) => { effects.signed++; effects.inputs = config.toSignInputs; return { signedTxHex: options.signedHex || fixture.transaction } } })
    }
    if (name === 'fs') return { existsSync: () => false }
    if (name === './src20-validator') return require('../src20-validator')
    return require(name)
  }, { process: { env: { STAMPY_CUSTODY_LIVE: '1' } }, fetch: async (url, request) => {
    if (url.includes('/src20/create')) return { ok: true, json: async () => ({ hex: options.psbtHex || make().psbtHex, inputsToSign: [{ index: 99, sighashType: 0x81 }] }) }
    if (request?.method === 'POST') { effects.broadcast++; return { ok: true, text: async () => signed.getId() } }
    return lookup()
  } })
  return { custody: result.exports, effects }
}
test('custody signs only validated inputs and validates before its mocked broadcast', async () => {
  const { custody, effects } = custodyHarness()
  const result = await custody.redeem({ tick: '$bald', amount: '1000', toAddress })
  assert.equal(result.txid, signed.getId())
  assert.equal(effects.signed, 1); assert.equal(effects.broadcast, 1)
  assert.deepEqual(Array.from(effects.inputs, x => ({ ...x })), [{ index: 0, address: from, sighashType: 1 }])
})
test('custody does not obtain signatures for a different transfer amount', async () => {
  const { custody, effects } = custodyHarness({ psbtHex: make({ data: dataOutputs(JSON.stringify({ ...payload, amt: '999' })) }).psbtHex })
  await assert.rejects(custody.redeem({ tick: '$bald', amount: '1000', toAddress }), /amount mismatch/)
  assert.equal(effects.signed, 0); assert.equal(effects.broadcast, 0)
})
test('custody refuses an altered signer transaction before broadcast', async () => {
  const changed = bitcoin.Transaction.fromHex(fixture.transaction); changed.outs[0].value++
  const { custody, effects } = custodyHarness({ signedHex: changed.toHex() })
  await assert.rejects(custody.redeem({ tick: '$bald', amount: '1000', toAddress }), /changed the transaction/)
  assert.equal(effects.signed, 1); assert.equal(effects.broadcast, 0)
})
