// StampySwap — CUSTODY via the Emblem Vault's managed Bitcoin address.
// The deposit/custody address is the SAME Emblem vault (1418056707) we already use for
// Solana + EVM authority — so SRC-20 custody needs NO raw Bitcoin key. Deposits land at the
// vault's mainnet BTC address; redemption is signed by the vault via Emblem's signPsbt.
//
// SAFETY: this is a REAL mainnet Bitcoin address. Obtaining it + watching it is free/read-only.
// Actually SOLICITING deposits and RELEASING funds are real-value actions, gated behind
// CUSTODY_LIVE (default off) + an audited go-ahead. Nothing here moves value on its own.
const bitcoin = require('@emblemvault/auth-sdk/signers/bitcoin')
const bitcoinjs = require('bitcoinjs-lib')
const fs = require('fs')
const path = require('path')
const CP = process.env.COUNTERPARTY_API || 'https://api.counterparty.io:4000/v2'

// Live-custody gate: env var OR a local .custody-live flag file (so it can be toggled for a
// controlled test without redeploying). Checked dynamically each call.
const FLAG = path.join(__dirname, '.custody-live')
function isLive() { return String(process.env.STAMPY_CUSTODY_LIVE || '0') === '1' || fs.existsSync(FLAG) }
let _info = null
async function vaultInfo() {
  if (!_info) _info = await bitcoin.fetchBitcoinVaultInfo({ apiKey: process.env.EMBLEM_API_KEY })
  return _info
}

// The custody deposit address = the Emblem vault's native-segwit (p2wpkh) BTC address.
async function depositAddress() {
  try { return (await vaultInfo()).btcAddresses.p2wpkh } catch (_) { return null }
}

async function status() {
  try {
    const i = await vaultInfo()
    return {
      provider: 'emblem-vault', managed: true, vault_id: i.vaultId,
      address: i.btcAddresses.p2wpkh, addresses: i.btcAddresses,
      live: isLive(),
      // `live` gates the RISKY release/redemption path only. Deposits + mint are always
      // operational (real assets are already custodied here). Be accurate, not scary.
      deposits_live: true,
      note: isLive()
        ? 'Custody LIVE — real assets held in this Emblem-managed vault. Deposit→mint and redemption/release are both operational.'
        : 'Custody is live and holding real assets (Emblem-managed vault). Deposit→mint is operational; redemption/release is gated behind an operator safety flag (enabled per-run for verified withdrawals).',
    }
  } catch (e) { return { provider: 'none', managed: false, live: false, error: String(e.message || e) } }
}

// Managed Bitcoin signer for the vault (used by the redemption path). No raw key.
async function btcSigner() { return bitcoin.toBitcoinSigner({ apiKey: process.env.EMBLEM_API_KEY }, await vaultInfo()) }

// REDEEM (real-value release path) — release `amount` of `tick` from the vault back to the
// user's BTC address. Structured but GATED: builds the SRC-20 TRANSFER via stampchain
// (sourceAddress = vault), signs the PSBT with the vault's managed signer, broadcasts.
// PROVEN flow (first real run 2026-08-12, redeem tx fccbd6f4…):
//  stampchain builds the transfer PSBT (field `hex`) → vault signs via Emblem (transactionType
//  = the address type 'p2wpkh', toSignInputs from `inputsToSign`) → response.signedTxHex → broadcast.
// REDEEM a Counterparty (XCP) asset: compose a `send` from the vault (counterparty-core
// returns a ready base64 PSBT funded by the vault's UTXOs), sign it with the vault's managed
// signer, broadcast. `qtyBase` is integer base units (8dp for divisible). GATED.
async function redeemCounterparty({ asset, amountWhole, qtyBase, toAddress }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  const from = await depositAddress()
  const url = `${CP}/addresses/${encodeURIComponent(from)}/compose/send?destination=${encodeURIComponent(toAddress)}&asset=${encodeURIComponent(asset)}&quantity=${qtyBase}&verbose=true`
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`counterparty compose ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json(); const built = j && j.result
  if (!built || !built.psbt) throw new Error('counterparty compose returned no psbt')
  // SAFETY: assert the composed tx matches what we asked (right asset, dest, amount) before signing
  const p = built.params || {}
  if (String(p.asset) !== String(asset)) throw new Error(`composed asset mismatch: ${p.asset}`)
  if (String(p.destination) !== String(toAddress)) throw new Error(`composed destination mismatch: ${p.destination}`)
  if (BigInt(p.quantity) !== BigInt(qtyBase)) throw new Error(`composed quantity mismatch: ${p.quantity} != ${qtyBase}`)
  // Counterparty PSBTs are "bare" — no per-input witnessUtxo — so the vault signer can't sign
  // them as-is. Enrich each input with its witnessUtxo from the compose response's lock_scripts
  // + inputs_values (the scriptPubKey + value of the UTXO being spent).
  const psbt = bitcoinjs.Psbt.fromBase64(built.psbt)
  const locks = built.lock_scripts || [], vals = built.inputs_values || []
  psbt.data.inputs.forEach((inp, i) => {
    if (!inp.witnessUtxo && !inp.nonWitnessUtxo && locks[i] && vals[i] != null) {
      psbt.updateInput(i, { witnessUtxo: { script: Buffer.from(locks[i], 'hex'), value: Number(vals[i]) } })
    }
  })
  const psbtHex = psbt.toHex()
  const nIn = psbt.data.inputs.length
  const toSignInputs = Array.from({ length: nIn }, (_, i) => ({ index: i, address: from, sighashType: 1 }))
  const signer = await btcSigner()
  const signedResp = await signer.signPsbt(psbtHex, { transactionType: 'p2wpkh', toSignInputs })
  const txHex = signedResp && signedResp.signedTxHex
  if (!txHex) throw new Error('vault signer returned no signedTxHex')
  const b = await fetch('https://mempool.space/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex })
  const txid = (await b.text()).trim()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('broadcast failed: ' + txid.slice(0, 160))
  return { released: true, protocol: 'counterparty', asset, amount: String(amountWhole), to: toAddress, txid, explorer: `https://mempool.space/tx/${txid}` }
}

async function redeem({ tick, amount, toAddress, feeRate = 2, protocol = 'src-20', qtyBase }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  if (protocol === 'counterparty') return redeemCounterparty({ asset: tick, amountWhole: amount, qtyBase, toAddress })
  const from = await depositAddress()
  const r = await fetch('https://stampchain.io/api/v2/src20/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'transfer', tick, amt: String(amount), sourceAddress: from, changeAddress: from, toAddress, feeRate }),
  })
  if (!r.ok) throw new Error(`stampchain create ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const built = await r.json()
  const psbtHex = built.hex
  if (!psbtHex) throw new Error('no PSBT (hex) returned by stampchain')
  const toSignInputs = (built.inputsToSign || []).map(i => ({ index: i.index, address: from, sighashType: i.sighashType }))
  const signer = await btcSigner()
  const signedResp = await signer.signPsbt(psbtHex, { transactionType: 'p2wpkh', toSignInputs })
  const txHex = signedResp && signedResp.signedTxHex
  if (!txHex) throw new Error('vault signer returned no signedTxHex')
  const b = await fetch('https://mempool.space/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex })
  const txid = (await b.text()).trim()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('broadcast failed: ' + txid.slice(0, 160))
  return { released: true, tick, amount: String(amount), to: toAddress, txid, explorer: `https://mempool.space/tx/${txid}` }
}

module.exports = { depositAddress, status, redeem, vaultInfo, isLive }
