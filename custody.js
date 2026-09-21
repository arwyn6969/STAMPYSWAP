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

async function redeemCounterparty({ asset, amountWhole, qtyBase, toAddress }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  const from = await depositAddress()
  const url = `${CP}/addresses/${encodeURIComponent(from)}/compose/send?destination=${encodeURIComponent(toAddress)}&asset=${encodeURIComponent(asset)}&quantity=${qtyBase}&verbose=true`
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`counterparty compose ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json(); const built = j && j.result
  if (!built || !built.psbt) throw new Error('counterparty compose returned no psbt')
  const p = built.params || {}
  if (String(p.asset) !== String(asset)) throw new Error(`composed asset mismatch: ${p.asset}`)
  if (String(p.destination) !== String(toAddress)) throw new Error(`composed destination mismatch: ${p.destination}`)
  if (BigInt(p.quantity) !== BigInt(qtyBase)) throw new Error(`composed quantity mismatch: ${p.quantity} != ${qtyBase}`)
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

const ACME_FEE_ADDRESS = process.env.ACME_FEE_ADDRESS || 'bc1qhyp5ate6djkanwrg00wft7jw9e5k456fc8wpgx'
const ACME_FEE_SATS = parseInt(process.env.ACME_FEE_SATS || '888', 10)
const DUST = 546
const ACME_ENV_V1 = process.env.ACME_ENV_V1 || '41434d4501000000'
const ACME_ENV_V2 = process.env.ACME_ENV_V2 || '41434d450204000000'
const acme = (() => { try { return require('./acme') } catch (_) { return null } })()

async function mempoolUtxos(addr) {
  const r = await fetch(`https://mempool.space/api/address/${encodeURIComponent(addr)}/utxo`)
  if (!r.ok) throw new Error(`utxo fetch ${r.status}`)
  const u = await r.json()
  return u.filter(x => x.status && x.status.confirmed).sort((a, b) => b.value - a.value)
}

async function redeemAcme({ asset, amountWhole, qtyBase, toAddress, feeRate = 3 }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  if (!acme) throw new Error('ACME adapter unavailable')
  const from = await depositAddress()
  const built = await acme.composeSend({ from, toAddress, asset, qtyWhole: amountWhole, dec: 8 })
  const rawEnv = built && built.envelope && built.envelope.hex
  if (!rawEnv) throw new Error('acme compose returned no envelope')
  const env = rawEnv.startsWith(ACME_ENV_V1) ? ACME_ENV_V2 + rawEnv.slice(ACME_ENV_V1.length) : rawEnv
  if (!env.startsWith(ACME_ENV_V2)) throw new Error(`unexpected ACME envelope header ${env.slice(0, 18)} — expected v1 (${ACME_ENV_V1}) or v2 (${ACME_ENV_V2})`)
  const p = (built.message && built.message.params) || {}
  if (String(p.asset) !== String(asset)) throw new Error(`composed asset mismatch: ${p.asset}`)
  if (String(p.destination) !== String(toAddress)) throw new Error(`composed destination mismatch: ${p.destination}`)
  if (qtyBase != null && BigInt(p.quantity) !== BigInt(qtyBase)) throw new Error(`composed quantity mismatch: ${p.quantity} != ${qtyBase}`)
  const utxos = await mempoolUtxos(from)
  if (!utxos.length) throw new Error('vault has no confirmed BTC UTXOs to fund the redeem')
  const script = bitcoinjs.address.toOutputScript(from, bitcoinjs.networks.bitcoin)
  const opReturn = bitcoinjs.payments.embed({ data: [Buffer.from(env, 'hex')] }).output
  const picked = []; let inSum = 0
  const estFee = (nIn) => Math.ceil((11 + nIn * 68 + (9 + opReturn.length) + 31 + 31) * feeRate)
  for (const u of utxos) {
    picked.push(u); inSum += u.value
    if (inSum >= ACME_FEE_SATS + estFee(picked.length) + DUST) break
  }
  const minerFee = estFee(picked.length)
  const change = inSum - ACME_FEE_SATS - minerFee
  if (change < 0) throw new Error(`vault BTC insufficient for redeem: have ${inSum}, need ${ACME_FEE_SATS + minerFee}+ sats`)
  const psbt = new bitcoinjs.Psbt({ network: bitcoinjs.networks.bitcoin })
  for (const u of picked) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value } })
  psbt.addOutput({ script: opReturn, value: 0 })
  psbt.addOutput({ address: ACME_FEE_ADDRESS, value: ACME_FEE_SATS })
  if (change >= DUST) psbt.addOutput({ address: from, value: change })
  const toSignInputs = picked.map((_, i) => ({ index: i, address: from, sighashType: 1 }))
  const signer = await btcSigner()
  const signedResp = await signer.signPsbt(psbt.toHex(), { transactionType: 'p2wpkh', toSignInputs })
  const txHex = signedResp && signedResp.signedTxHex
  if (!txHex) throw new Error('vault signer returned no signedTxHex')
  const b = await fetch('https://mempool.space/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex })
  const txid = (await b.text()).trim()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('broadcast failed: ' + txid.slice(0, 200))
  return { released: true, protocol: 'acme', asset, amount: String(amountWhole), to: toAddress, txid, fee_sats: minerFee, acme_fee_sats: ACME_FEE_SATS, explorer: `https://mempool.space/tx/${txid}` }
}

async function redeem({ tick, amount, toAddress, feeRate = 2, protocol = 'src-20', qtyBase }) {
  if (!isLive()) { const e = new Error('custody redemption is gated (STAMPY_CUSTODY_LIVE off) — audited go-ahead required'); e.code = 'GATED'; throw e }
  if (protocol === 'acme') return redeemAcme({ asset: tick, amountWhole: amount, qtyBase, toAddress })
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
  const echoed = built.tick || built.ticker || (built.payload && (built.payload.tick || built.payload.ticker))
  const echoedTo = built.toAddress || built.destination || (built.payload && (built.payload.toAddress || built.payload.destination))
  const echoedAmt = built.amt || built.amount || (built.payload && (built.payload.amt || built.payload.amount))
  if (echoed && String(echoed).toLowerCase() !== String(tick).toLowerCase()) throw new Error(`stampchain tick mismatch: ${echoed}`)
  if (echoedTo && String(echoedTo) !== String(toAddress)) throw new Error(`stampchain destination mismatch: ${echoedTo}`)
  if (echoedAmt != null && String(echoedAmt) !== String(amount)) throw new Error(`stampchain amount mismatch: ${echoedAmt}`)
  if (built.sourceAddress && String(built.sourceAddress) !== String(from)) throw new Error(`stampchain source mismatch: ${built.sourceAddress}`)
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

module.exports = { depositAddress, status, redeem, redeemAcme, vaultInfo, isLive }
