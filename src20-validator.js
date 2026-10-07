'use strict'
const bitcoin = require('bitcoinjs-lib')
const { TextDecoder } = require('node:util')
const secp = require('@bitcoinerlab/secp256k1')

// Current Stampchain OLGA composer: length-prefixed stamp: JSON in contiguous P2WSH outputs.
// Protocol sources and a public indexed redemption fixture are pinned in docs/src20-validation.md.
// Unsupported encodings fail closed. This checks intent; indexer confirmation remains necessary.
function refuse(message) { throw new Error('refusing to sign SRC-20 redeem: ' + message) }
function decimal(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/.test(value)) refuse('invalid transfer amount')
  const [whole, fraction = ''] = value.split('.')
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
  if (units <= 0n) refuse('transfer amount must be positive')
  return units
}
function cap(env, name, maximum) {
  const value = env[name] === undefined ? maximum : Number(env[name])
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) refuse('invalid or excessive ' + name)
  return value
}
function parseIntent({ psbtHex, from, toAddress, tick, amount, env = {} }) {
  if (typeof psbtHex !== 'string' || psbtHex.length > 200000 || !/^(?:[a-f0-9]{2})+$/i.test(psbtHex)) refuse('invalid PSBT hex')
  let psbt, vaultScript, recipientScript
  try {
    psbt = bitcoin.Psbt.fromHex(psbtHex)
    vaultScript = bitcoin.address.toOutputScript(from)
    recipientScript = bitcoin.address.toOutputScript(toAddress)
  } catch (_) { refuse('could not decode the PSBT or addresses') }
  if (vaultScript.length !== 22 || vaultScript[0] !== 0 || vaultScript[1] !== 20) refuse('vault must use P2WPKH')
  if (vaultScript.equals(recipientScript)) refuse('recipient cannot be the custody vault')
  if (typeof tick !== 'string' || !/^[\x21-\x7e]{1,5}$/.test(tick)) refuse('unsupported ticker encoding')
  const inputs = psbt.txInputs, outputs = psbt.txOutputs
  if (!inputs.length || inputs.length > 50 || outputs.length < 2 || outputs.length > 20) refuse('invalid input/output count')
  const dustCap = cap(env, 'SRC20_DUST_SATS', 1000)
  const nonVaultCap = cap(env, 'SRC20_MAX_NONVAULT_SATS', 5000)
  let outSum = 0, nonVault = 0
  for (const output of outputs) {
    if (!Number.isSafeInteger(output.value) || output.value < 0) refuse('invalid output value')
    outSum += output.value
  }
  if (!Number.isSafeInteger(outSum)) refuse('invalid output sum')
  if (!outputs[0].script.equals(recipientScript)) refuse('first output does not pay the requested recipient')
  if (outputs[0].value < 333 || outputs[0].value > dustCap) refuse('recipient value exceeds dust policy or is below composer dust')
  nonVault += outputs[0].value
  const chunks = []
  let index = 1
  for (; index < outputs.length; index++) {
    const output = outputs[index], script = output.script
    if (script.length !== 34 || script[0] !== 0 || script[1] !== 32) break
    if (output.value < 333 || output.value > dustCap) refuse('data value exceeds dust policy or is below composer dust')
    chunks.push(script.subarray(2)); nonVault += output.value
  }
  if (!chunks.length) refuse('missing OLGA transfer data')
  if (index < outputs.length && (index !== outputs.length - 1 || !outputs[index].script.equals(vaultScript))) refuse('unexpected output or change destination')
  if (nonVault > nonVaultCap) refuse('non-vault value exceeds policy')
  const data = Buffer.concat(chunks), length = data.readUInt16BE(0)
  if (length < 7 || length > 512 || Math.ceil((length + 2) / 32) !== chunks.length || length + 2 > data.length) refuse('invalid OLGA data length')
  if (data.subarray(length + 2).some(byte => byte !== 0)) refuse('nonzero OLGA padding')
  const body = data.subarray(2, length + 2)
  if (!body.subarray(0, 6).equals(Buffer.from('stamp:'))) refuse('invalid stamp prefix')
  let text, payload
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(6)); payload = JSON.parse(text) } catch (_) { refuse('invalid transfer JSON') }
  // The current composer emits compact JSON. Requiring this also rejects duplicate keys and
  // ambiguous numeric representations before any signer is obtained.
  if (!payload || Array.isArray(payload) || JSON.stringify(payload) !== text || Object.keys(payload).sort().join(',') !== 'amt,op,p,tick') refuse('noncanonical or unexpected transfer fields')
  if (payload.p !== 'SRC-20' || payload.op !== 'TRANSFER') refuse('payload is not an SRC-20 TRANSFER')
  if (typeof payload.tick !== 'string' || payload.tick.toLowerCase() !== tick.toLowerCase()) refuse('transfer ticker mismatch')
  if (decimal(payload.amt) !== decimal(String(amount))) refuse('transfer amount mismatch')
  const seen = new Set()
  inputs.forEach((input, i) => {
    const data = psbt.data.inputs[i], outpoint = Buffer.from(input.hash).reverse().toString('hex') + ':' + input.index
    if (seen.has(outpoint)) refuse('duplicate input')
    seen.add(outpoint)
    if (data.sighashType !== undefined && data.sighashType !== bitcoin.Transaction.SIGHASH_ALL) refuse('unsafe input sighash')
    if (data.partialSig || data.finalScriptSig || data.finalScriptWitness || data.redeemScript || data.witnessScript || data.tapKeySig || data.tapLeafScript) refuse('unexpected input signing data')
    if (!data.witnessUtxo || !data.witnessUtxo.script.equals(vaultScript)) refuse('input is not a declared vault P2WPKH output')
  })
  return { psbt, vaultScript, outSum, payload, env }
}
async function readPrevious(txid, fetchImpl) {
  const response = await fetchImpl('https://mempool.space/api/tx/' + txid + '/hex', { signal: AbortSignal.timeout(15000) })
  if (!response.ok) refuse('previous transaction lookup failed')
  const raw = (await response.text()).trim()
  if (raw.length > 8000000 || !/^(?:[a-f0-9]{2})+$/i.test(raw)) refuse('invalid previous transaction hex')
  let previous
  try { previous = bitcoin.Transaction.fromHex(raw) } catch (_) { refuse('invalid previous transaction') }
  if (previous.getId() !== txid) refuse('previous transaction hash mismatch')
  return previous
}
async function validateTransfer(params, fetchImpl = fetch) {
  const intent = parseIntent(params), { psbt, vaultScript, env } = intent
  let inSum = 0
  const previous = new Map()
  for (let i = 0; i < psbt.txInputs.length; i++) {
    const input = psbt.txInputs[i], declared = psbt.data.inputs[i]
    const txid = Buffer.from(input.hash).reverse().toString('hex')
    if (!previous.has(txid)) previous.set(txid, await readPrevious(txid, fetchImpl))
    const output = previous.get(txid).outs[input.index]
    if (!output || !output.script.equals(vaultScript) || output.value !== declared.witnessUtxo.value || !output.script.equals(declared.witnessUtxo.script)) refuse('previous output ownership or value mismatch')
    if (declared.nonWitnessUtxo && !declared.nonWitnessUtxo.equals(previous.get(txid).toBuffer())) refuse('non-witness transaction mismatch')
    inSum += output.value
  }
  const fee = inSum - intent.outSum
  if (!Number.isSafeInteger(inSum) || fee < 0 || fee > cap(env, 'SRC20_MAX_FEE_SATS', 50000)) refuse('miner fee exceeds policy or outputs exceed inputs')
  // Unsigned stripped size is a strict lower bound on final vsize. A rate measured against it
  // is conservative even for unusually short valid DER signatures.
  const unsigned = psbt.data.globalMap.unsignedTx.toBuffer()
  if (fee / unsigned.length > cap(env, 'SRC20_MAX_FEE_RATE', 200)) refuse('miner fee rate exceeds policy')
  return { ...intent, fee, unsigned, toSignInputs: psbt.txInputs.map((_, index) => ({ index, address: params.from, sighashType: bitcoin.Transaction.SIGHASH_ALL })) }
}
function validateSigned(intent, signedHex) {
  let signed
  try { signed = bitcoin.Transaction.fromHex(signedHex) } catch (_) { refuse('signer returned an invalid transaction') }
  const expected = bitcoin.Transaction.fromBuffer(intent.unsigned)
  if (signed.getId() !== expected.getId() || signed.ins.length !== expected.ins.length) refuse('signer changed the transaction')
  for (let i = 0; i < signed.ins.length; i++) {
    const input = signed.ins[i]
    if (input.script.length || input.witness.length !== 2 || input.witness[0].length < 9 || input.witness[0].at(-1) !== 1 || input.witness[1].length !== 33) refuse('unexpected signed witness or sighash')
    const source = bitcoin.payments.p2wpkh({ pubkey: input.witness[1] }).output
    if (!source.equals(intent.vaultScript)) refuse('signed witness is not the vault key')
    let signature
    try { signature = bitcoin.script.signature.decode(input.witness[0]).signature } catch (_) { refuse('invalid DER signature') }
    const script = bitcoin.payments.p2pkh({ pubkey: input.witness[1] }).output
    const hash = signed.hashForWitnessV0(i, script, intent.psbt.data.inputs[i].witnessUtxo.value, bitcoin.Transaction.SIGHASH_ALL)
    if (!secp.verify(hash, input.witness[1], signature)) refuse('invalid vault signature')
  }
  return signed.getId()
}
module.exports = { parseIntent, validateTransfer, validateSigned }
