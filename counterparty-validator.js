'use strict'
const bitcoin = require('bitcoinjs-lib')
const src20 = require('./src20-validator')

// Deliberately narrow policy: canonical named/XCP assets, P2WPKH vault inputs,
// one OP_RETURN enhanced_send (ID 2), canonical definite CBOR array, empty memo,
// no BTC recipient/fee outputs and at most one change output back to the vault.
// Reference implementation pinned to Counterparty Core v11.5.0:
// https://github.com/CounterpartyXCP/counterparty-core/tree/8aab989157019e62423cd959b8571c7daf748d56
// See lib/messages/versions/enhancedsend.py, lib/api/composer.py,
// lib/parser/messagetype.py, lib/ledger/issuances.py and counterparty-rs/src/utils.rs.
// https://docs.counterparty.io/docs/advanced/specifications/counterparty-data-encoding/
// Unsupported encodings are refused, never interpreted from composer JSON params.
function refuse(message) { throw new Error('refusing to sign Counterparty redeem: ' + message) }
function assetId(asset) {
  if (asset === 'XCP') return 1n
  // Numeric/subasset names require a separately verified asset-ID mapping. Do not
  // infer that binding from an untrusted composer's asset/longname JSON fields.
  if (typeof asset !== 'string' || !/^[B-Z][A-Z]{3,11}$/.test(asset)) refuse('unsupported or unresolved canonical asset identity')
  let id = 0n
  for (const char of asset) id = id * 26n + BigInt(char.charCodeAt(0) - 65)
  return id
}
function quantity(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) refuse('quantity must be exact positive base units')
  const amount = BigInt(value)
  if (amount > (1n << 63n) - 1n) refuse('quantity exceeds Counterparty MAX_INT')
  return amount
}
function rc4(key, bytes) {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]] }
  let i = 0; j = 0
  return Buffer.from(bytes.map(byte => {
    i = (i + 1) & 255; j = (j + state[i]) & 255
    ;[state[i], state[j]] = [state[j], state[i]]
    return byte ^ state[(state[i] + state[j]) & 255]
  }))
}
function packedAddress(script) {
  if (script.length === 25 && script.subarray(0, 3).equals(Buffer.from('76a914', 'hex')) && script.subarray(23).equals(Buffer.from('88ac', 'hex')))
    return Buffer.concat([Buffer.from([1]), script.subarray(3, 23)])
  if (script.length === 23 && script.subarray(0, 2).equals(Buffer.from('a914', 'hex')) && script[22] === 0x87)
    return Buffer.concat([Buffer.from([2]), script.subarray(2, 22)])
  if ((script[0] === 0 && (script.length === 22 || script.length === 34)) || (script[0] === 0x51 && script.length === 34))
    return Buffer.concat([Buffer.from([3, script[0] === 0 ? 0 : 1]), script.subarray(2)])
  refuse('unsupported recipient address encoding')
}
function decodeEnhancedSend(bytes) {
  // Not a general-purpose CBOR decoder: only the exact four-field composer shape
  // is accepted. No tags, negative/float values, maps, nesting or indefinite lengths.
  let offset = 0
  const head = major => {
    if (offset >= bytes.length) refuse('truncated enhanced-send CBOR')
    const initial = bytes[offset++], additional = initial & 31
    if ((initial >> 5) !== major) refuse('unexpected enhanced-send CBOR type')
    if (additional < 24) return BigInt(additional)
    const width = ({ 24: 1, 25: 2, 26: 4, 27: 8 })[additional]
    if (!width || offset + width > bytes.length) refuse('unsupported or truncated CBOR length')
    let value = 0n
    for (let n = 0; n < width; n++) value = (value << 8n) + BigInt(bytes[offset++])
    if (value < ({ 1: 24n, 2: 256n, 4: 65536n, 8: 4294967296n })[width]) refuse('noncanonical CBOR integer')
    return value
  }
  const byteString = maximum => {
    const size = head(2)
    if (size > BigInt(maximum) || size > BigInt(bytes.length - offset)) refuse('unsupported enhanced-send byte string')
    const result = bytes.subarray(offset, offset + Number(size)); offset += Number(size)
    return result
  }
  if (head(4) !== 4n) refuse('enhanced send must have exactly four fields')
  const id = head(0), amount = head(0), destination = byteString(34), memo = byteString(0)
  if (memo.length || offset !== bytes.length) refuse('unexpected enhanced-send memo or trailing bytes')
  return { assetId: id, quantity: amount, destination }
}
function cap(env, name, maximum) {
  const value = env[name] === undefined ? maximum : Number(env[name])
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) refuse('invalid or excessive ' + name)
  return value
}
function parseIntent({ psbtBase64, from, toAddress, asset, qtyBase, env = {} }) {
  const expectedAsset = assetId(asset), expectedQuantity = quantity(qtyBase)
  if (typeof psbtBase64 !== 'string' || psbtBase64.length > 200000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(psbtBase64) || !psbtBase64)
    refuse('invalid PSBT base64')
  let psbt, vaultScript, recipientScript
  try { psbt = bitcoin.Psbt.fromBase64(psbtBase64); vaultScript = bitcoin.address.toOutputScript(from); recipientScript = bitcoin.address.toOutputScript(toAddress) } catch (_) { refuse('invalid PSBT or Bitcoin mainnet address') }
  if (vaultScript.length !== 22 || vaultScript[0] !== 0 || vaultScript[1] !== 20) refuse('vault must use P2WPKH')
  if (vaultScript.equals(recipientScript)) refuse('recipient cannot be the custody vault')
  const inputs = psbt.txInputs, outputs = psbt.txOutputs
  if (!inputs.length || inputs.length > 50 || !outputs.length || outputs.length > 2) refuse('unsupported input/output count')
  const unsigned = psbt.data.globalMap.unsignedTx.toBuffer(), tx = bitcoin.Transaction.fromBuffer(unsigned)
  if (![1, 2].includes(tx.version) || tx.locktime !== 0) refuse('unsupported transaction version or locktime')
  if (Object.keys(psbt.data.globalMap).some(key => key !== 'unsignedTx') || psbt.data.outputs.some(output => Object.keys(output).length)) refuse('unsupported PSBT global/output metadata')
  const chunks = bitcoin.script.decompile(outputs[0].script)
  if (!chunks || chunks.length !== 2 || chunks[0] !== bitcoin.opcodes.OP_RETURN || !Buffer.isBuffer(chunks[1]) || !bitcoin.script.compile(chunks).equals(outputs[0].script) || outputs[0].value !== 0)
    refuse('first output must be one canonical zero-value OP_RETURN')
  if (chunks[1].length > 80) refuse('OP_RETURN exceeds supported encoding size')
  const key = Buffer.from(inputs[0].hash).reverse(), plain = rc4(key, chunks[1])
  if (!plain.subarray(0, 8).equals(Buffer.from('CNTRPRTY')) || plain[8] !== 2) refuse('not the supported Counterparty enhanced send')
  const payload = decodeEnhancedSend(plain.subarray(9))
  if (payload.assetId !== expectedAsset) refuse('payload asset mismatch')
  if (payload.quantity !== expectedQuantity) refuse('payload quantity mismatch')
  if (!payload.destination.equals(packedAddress(recipientScript))) refuse('payload recipient mismatch')
  let outSum = 0
  for (const [index, output] of outputs.entries()) {
    if (!Number.isSafeInteger(output.value) || output.value < 0) refuse('invalid output value')
    if (index > 0 && !output.script.equals(vaultScript)) refuse('unapproved change or external Bitcoin output')
    outSum += output.value
  }
  const seen = new Set()
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i], data = psbt.data.inputs[i], outpoint = Buffer.from(input.hash).toString('hex') + ':' + input.index
    if (seen.has(outpoint)) refuse('duplicate input')
    seen.add(outpoint)
    if (input.sequence !== 0xffffffff && input.sequence !== 0xfffffffd) refuse('unsupported input sequence')
    if (Object.keys(data).some(key => !['witnessUtxo', 'nonWitnessUtxo', 'sighashType'].includes(key))) refuse('unexpected input signing or metadata fields')
    if (data.sighashType !== undefined && data.sighashType !== bitcoin.Transaction.SIGHASH_ALL) refuse('unsafe sighash')
    if (data.witnessUtxo && !data.witnessUtxo.script.equals(vaultScript)) refuse('declared input is not vault-owned')
  }
  return { psbt, vaultScript, unsigned, outSum, payload, env }
}
async function previousHex(response) {
  const maximum = 500000 // Bounded funding transactions only; larger ones are unsupported.
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > maximum) { await reader.cancel(); refuse('previous transaction body exceeds size policy') }
        chunks.push(Buffer.from(next.value))
      }
      return Buffer.concat(chunks).toString('utf8').trim()
    } finally { reader.releaseLock() }
  }
  // Text-only transports are used by the offline fixtures. Real fetch bodies take
  // the streaming branch above, so an oversized provider body is never buffered.
  const raw = (await response.text()).trim()
  if (raw.length > maximum) refuse('previous transaction body exceeds size policy')
  return raw
}
async function validateTransfer(params, fetchImpl = fetch) {
  const intent = parseIntent(params), previous = new Map()
  let inSum = 0, totalPreviousHex = 0
  for (let index = 0; index < intent.psbt.txInputs.length; index++) {
    const input = intent.psbt.txInputs[index], data = intent.psbt.data.inputs[index]
    const txid = Buffer.from(input.hash).reverse().toString('hex')
    if (!previous.has(txid)) {
      const response = await fetchImpl('https://mempool.space/api/tx/' + txid + '/hex', { signal: AbortSignal.timeout(15000) })
      if (!response.ok) refuse('previous transaction lookup failed')
      const raw = await previousHex(response)
      totalPreviousHex += raw.length
      if (totalPreviousHex > 2000000) refuse('aggregate previous transaction data exceeds size policy')
      if (!/^(?:[a-f0-9]{2})+$/i.test(raw)) refuse('invalid previous transaction hex')
      let tx
      try { tx = bitcoin.Transaction.fromHex(raw) } catch (_) { refuse('invalid previous transaction') }
      if (tx.getId() !== txid) refuse('previous transaction hash mismatch')
      previous.set(txid, tx)
    }
    const tx = previous.get(txid), output = tx.outs[input.index]
    if (!output || !output.script.equals(intent.vaultScript) || !Number.isSafeInteger(output.value)) refuse('previous output is not vault-owned')
    if (data.witnessUtxo && (data.witnessUtxo.value !== output.value || !data.witnessUtxo.script.equals(output.script))) refuse('composer previous-output value/script mismatch')
    if (data.nonWitnessUtxo && !data.nonWitnessUtxo.equals(tx.toBuffer())) refuse('composer non-witness transaction mismatch')
    // Composer lock_scripts/inputs_values are never proof. Enrich bare inputs only
    // from the independently fetched raw transaction whose txid was checked above.
    if (!data.witnessUtxo) intent.psbt.updateInput(index, { witnessUtxo: { script: output.script, value: output.value } })
    inSum += output.value
  }
  const fee = inSum - intent.outSum
  if (!Number.isSafeInteger(inSum) || !Number.isSafeInteger(intent.outSum) || fee < 0 || fee > cap(intent.env, 'CP_MAX_FEE_SATS', 50000)) refuse('miner fee exceeds policy or outputs exceed inputs')
  // Unsigned stripped size is a lower bound on final vsize: this rate cap is conservative.
  if (fee / intent.unsigned.length > cap(intent.env, 'CP_MAX_FEE_RATE', 200)) refuse('miner fee rate exceeds policy')
  return { ...intent, fee, toSignInputs: intent.psbt.txInputs.map((_, index) => ({ index, address: params.from, sighashType: bitcoin.Transaction.SIGHASH_ALL })) }
}
function validateSigned(intent, signedHex) {
  if (typeof signedHex !== 'string' || signedHex.length > 400000 || !/^(?:[a-f0-9]{2})+$/i.test(signedHex)) refuse('invalid signed transaction hex')
  try { return src20.validateSigned(intent, signedHex) } catch (error) { refuse(String(error.message).replace(/^refusing to sign SRC-20 redeem: /, '')) }
}
module.exports = { assetId, quantity, parseIntent, validateTransfer, validateSigned }
