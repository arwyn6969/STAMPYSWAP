// StampySwap — Counterparty (XCP) asset support. A different Bitcoin protocol than SRC-20,
// but assets are still balance-per-address, so the SAME Emblem vault BTC address custodies
// them. Discovery via counterparty-core v2; redemption = a Counterparty `send` (compose →
// vault signs → broadcast). Divisible assets use 8 decimals; indivisible use 0.
const CP = process.env.COUNTERPARTY_API || 'https://api.counterparty.io:4000/v2'

async function cpGet(pathname) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(`${CP}${pathname}`, { headers: { accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) throw new Error(`counterparty ${r.status}`)
    return (await r.json())
  } finally { clearTimeout(t) }
}
const xcpDecimals = divisible => (divisible ? 8 : 0)
// base units (integer string) → whole-unit decimal string
function fromBase(baseStr, dec) {
  let s = String(baseStr || '0').replace(/[^0-9]/g, '') || '0'
  if (dec === 0) return s
  s = s.padStart(dec + 1, '0')
  const i = s.slice(0, -dec).replace(/^0+(?=\d)/, ''), f = s.slice(-dec).replace(/0+$/, '')
  return f ? `${i}.${f}` : i
}
// whole-unit decimal string → base units (integer string)
function toBase(whole, dec) {
  const [i, f = ''] = String(whole).split('.')
  const frac = (f.replace(/[^0-9]/g, '') + '0'.repeat(dec)).slice(0, dec)
  const s = (String(i).replace(/[^0-9]/g, '') || '0') + frac
  return s.replace(/^0+(?=\d)/, '') // strip leading zeros, keep ≥1 digit (canonical base-unit integer)
}

// Look up a Counterparty asset by name (e.g. PUDSEC) or longname.
async function lookupAsset(name) {
  let j; try { j = await cpGet(`/assets/${encodeURIComponent(name)}`) } catch (_) { return null }
  const r = j && j.result
  if (!r || !r.asset) return null
  const dec = xcpDecimals(r.divisible)
  return {
    protocol: 'counterparty', asset: r.asset, exact_ticker: r.asset, longname: r.asset_longname || null,
    issuer: r.issuer || null, decimals: dec, divisible: !!r.divisible, locked: !!r.locked,
    supply_base: String(r.supply), max_supply: fromBase(String(r.supply), dec),
  }
}

// Confirmed balance (base units) of an asset at an address.
async function addressBalanceBase(addr, asset) {
  let j; try { j = await cpGet(`/addresses/${encodeURIComponent(addr)}/balances`) } catch (_) { return '0' }
  const rows = (j && j.result) || []
  const row = rows.find(x => x.asset === asset || x.asset_longname === asset)
  return row ? String(row.quantity) : '0'
}

// Did `source` send `asset` to `vault` in a confirmed (valid) Counterparty send? Used to bind an
// XCP deposit credit to a real depositor (front-running defense). Best-effort attribution.
async function sentToVault(asset, source, vault) {
  let j; try { j = await cpGet(`/assets/${encodeURIComponent(asset)}/sends?limit=200`) } catch (_) { return false }
  const rows = (j && j.result) || []
  return rows.some(r => r.source === source && r.destination === vault && (r.status === 'valid' || r.status == null))
}

// Current chain height (for confirmation depth if needed).
async function chainHeight() { try { const j = await cpGet('/'); return (j.result && (j.result.counterparty_height || j.result.backend_height)) || null } catch (_) { return null } }

// Deposit check: does `vault` hold ≥ `qtyWhole` of `asset`? (Counterparty balances are
// confirmed-only, so a present balance means the send settled.) txid attribution + full
// tx verification will be refined against the first real PUDSEC deposit.
async function checkDeposit(vault, asset, qtyWhole, dec) {
  const balBase = await addressBalanceBase(vault, asset)
  const need = BigInt(toBase(qtyWhole, dec))
  return { arrived: BigInt(balBase || '0') >= need, balance_base: balBase, balance: fromBase(balBase, dec) }
}

// REDEEM: release `qtyWhole` of a Counterparty asset from the vault via a `send` — compose
// the tx, sign with the vault's managed signer, broadcast. Scaffolded; finalized against the
// first real redeem (like SRC-20). GATED by the caller (custody live).
async function composeSend({ from, toAddress, asset, qtyWhole, dec }) {
  const qtyBase = toBase(qtyWhole, dec)
  const j = await cpGet(`/addresses/${encodeURIComponent(from)}/compose/send?destination=${encodeURIComponent(toAddress)}&asset=${encodeURIComponent(asset)}&quantity=${qtyBase}&validate=true`)
  return j && j.result
}

module.exports = { lookupAsset, addressBalanceBase, checkDeposit, composeSend, chainHeight, sentToVault, fromBase, toBase, xcpDecimals }
