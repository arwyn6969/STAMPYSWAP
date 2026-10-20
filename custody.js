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
const src20 = require('./src20-validator')
const fs = require('fs')
const path = require('path')

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
async function redeemCounterparty({ asset, amountWhole, qtyBase, toAddress, dec = 8 }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  const counterparty = require('./counterparty')
  const validator = require('./counterparty-validator')
  if (qtyBase == null) throw new Error('authoritative Counterparty base-unit quantity is required')
  const exactBase = counterparty.releaseQuantity(amountWhole, dec, qtyBase)
  validator.assetId(asset) // Unsupported/unresolved identities fail before any remote call.
  const from = await depositAddress()
  const built = await counterparty.composeSend({ from, toAddress, asset, qtyWhole: amountWhole, dec, qtyBase: exactBase })
  if (!built || !built.psbt) throw new Error('counterparty compose returned no psbt')
  const validated = await validator.validateTransfer({ psbtBase64: built.psbt, from, toAddress, asset, qtyBase: exactBase, env: process.env }, fetch)
  // JSON params, lock_scripts and inputs_values are never authority for the bytes
  // or funding values. Validation decodes the payload and verifies raw prevouts.
  const signer = await btcSigner()
  const signedResp = await signer.signPsbt(validated.psbt.toHex(), { transactionType: 'p2wpkh', toSignInputs: validated.toSignInputs })
  const txHex = signedResp && signedResp.signedTxHex
  if (!txHex) throw new Error('vault signer returned no signedTxHex')
  const expectedTxid = validator.validateSigned(validated, txHex)
  const b = await fetch('https://mempool.space/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex })
  const txid = (await b.text()).trim()
  if (!b.ok || txid !== expectedTxid) throw new Error('counterparty broadcast response did not match the validated transaction')
  return { released: true, protocol: 'counterparty', asset, amount: String(amountWhole), to: toAddress, txid, explorer: `https://mempool.space/tx/${txid}` }
}

// ACME's opaque compressed envelope, empirical header rewrite and inferred fee
// address are insufficient signing policy. No flag enables this unsupported path.
const acme = (() => { try { return require('./acme') } catch (_) { return null } })()
async function redeemAcme() {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  if (!acme || typeof acme.requireReleaseValidation !== 'function') throw new Error('ACME release validator unavailable — release refused')
  acme.requireReleaseValidation() // Always refuses before vault lookup, compose, signing or broadcast.
}

async function redeem({ tick, amount, toAddress, feeRate = 2, protocol = 'src-20', qtyBase, dec = 8 }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  if (protocol === 'acme') return redeemAcme({ asset: tick, amountWhole: amount, qtyBase, toAddress, dec })
  if (protocol === 'counterparty') return redeemCounterparty({ asset: tick, amountWhole: amount, qtyBase, toAddress, dec })
  if (protocol !== 'src-20') throw new Error('unsupported custody release protocol')
  const from = await depositAddress()
  const r = await fetch('https://stampchain.io/api/v2/src20/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'transfer', tick, amt: String(amount), sourceAddress: from, changeAddress: from, toAddress, feeRate }),
  })
  if (!r.ok) throw new Error(`stampchain create ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const built = await r.json()
  const psbtHex = built.hex
  if (!psbtHex) throw new Error('no PSBT (hex) returned by stampchain')
  const validated = await src20.validateTransfer({ psbtHex, from, toAddress, tick, amount: String(amount), env: process.env }, fetch)
  const toSignInputs = validated.toSignInputs
  const signer = await btcSigner()
  const signedResp = await signer.signPsbt(psbtHex, { transactionType: 'p2wpkh', toSignInputs })
  const txHex = signedResp && signedResp.signedTxHex
  if (!txHex) throw new Error('vault signer returned no signedTxHex')
  const expectedTxid = src20.validateSigned(validated, txHex)
  const b = await fetch('https://mempool.space/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex })
  const txid = (await b.text()).trim()
  if (!b.ok || txid !== expectedTxid) throw new Error('broadcast failed: ' + txid.slice(0, 160))
  return { released: true, tick, amount: String(amount), to: toAddress, txid, explorer: `https://mempool.space/tx/${txid}` }
}

module.exports = { depositAddress, status, redeem, redeemAcme, vaultInfo, isLive }
