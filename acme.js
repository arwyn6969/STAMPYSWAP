// StampySwap — ACME protocol adapter (Phase 0).
//
// ACME ("Assets Coded on the Monetary Engine") is a Counterparty-STYLE token protocol on
// Bitcoin with its OWN indexer (acme.pics) and its own asset namespace. Assets are
// balance-per-address, so the SAME Emblem vault BTC address custodies them — this adapter
// mirrors counterparty.js almost exactly (same 8/0 decimal model, same fromBase/toBase).
//
// Key differences vs counterparty.js:
//   • base URL is acme.pics, not counterparty.io
//   • redemption compose is a POST (JSON body) instead of a GET query
//   • treat ACME as its OWN source_protocol ('acme') — do NOT route through counterparty.io,
//     to avoid ticker/asset collisions between the two distinct protocols.
//
// Drop-in: place next to counterparty.js in the stampyswap tree; wire lookupAsset into the
// /api/discover dispatch chain (counterparty → src-20 → acme) writing source_protocol='acme'.
const AP = process.env.ACME_API || 'https://acme.pics/api'

async function apGet(pathname) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(`${AP}${pathname}`, { headers: { accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) throw new Error(`acme ${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}
// POST — tolerant of non-JSON error bodies (acme.pics returns plain-text serde errors like
// "Failed to deserialize…" on a bad body). Always resolves to an object.
async function apPost(pathname, body) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(`${AP}${pathname}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    })
    const txt = await r.text()
    try { return JSON.parse(txt) } catch (_) { return { error: txt.slice(0, 200) } }
  } finally { clearTimeout(t) }
}

const acmeDecimals = divisible => (divisible ? 8 : 0)

// base units (integer string) → whole-unit decimal string  [identical to counterparty.js]
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

// Look up an ACME asset by name (e.g. SOAP) or longname → normalized shape matching counterparty.js.
async function lookupAsset(name) {
  let j; try { j = await apGet(`/assets/${encodeURIComponent(name)}`) } catch (_) { return null }
  const r = j && j.result
  if (!r || !r.asset) return null
  const dec = acmeDecimals(r.divisible)
  return {
    protocol: 'acme', asset: r.asset, exact_ticker: r.asset, longname: r.asset_longname || null,
    issuer: r.issuer || r.owner || null, decimals: dec, divisible: !!r.divisible, locked: !!r.locked,
    supply_base: String(r.supply), max_supply: fromBase(String(r.supply), dec),
  }
}

// Confirmed spendable balance (base units) of an asset at an address.
//
// PHASE-0 FINDING: ACME's `/addresses/{addr}/balances` UNDER-REPORTS main-token holdings
// (returns 0 for an address the asset's holder list shows as holding 70M). The authoritative
// source is `/assets/{asset}/holders` filtered by address, summing holding_type='balances'
// (excludes 'open_order'/escrow, which aren't spendable for custody/redemption). We page via
// next_cursor. NOTE: flag this discrepancy to the ACME team; if a correct per-address endpoint
// ships later, prefer it.
async function addressBalanceBase(addr, asset) {
  let total = 0n, cursor = null, pages = 0
  try {
    do {
      const q = `/assets/${encodeURIComponent(asset)}/holders?limit=1000${cursor != null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const j = await apGet(q)
      const rows = (j && j.result) || []
      for (const r of rows) {
        if (r.address === addr && (r.holding_type === 'balances' || r.holding_type == null)) {
          total += BigInt(String(r.quantity || '0').replace(/[^0-9]/g, '') || '0')
        }
      }
      cursor = j && j.next_cursor
      pages++
    } while (cursor != null && pages < 50)
  } catch (_) { /* fall through to whatever we accumulated */ }
  return total.toString()
}

// Did `source` send `asset` to `vault` in a confirmed ACME send? Binds a deposit credit to a
// real depositor (front-running defense). Best-effort attribution.
async function sentToVault(asset, source, vault) {
  let j; try { j = await apGet(`/assets/${encodeURIComponent(asset)}/sends?limit=200`) } catch (_) { return false }
  const rows = (j && j.result) || []
  return rows.some(r => r.source === source && r.destination === vault && (r.status === 'valid' || r.status == null))
}

// Current ACME chain height.
async function chainHeight() {
  try { const j = await apGet('/blocks/last'); return (j.result && j.result.block_index) || null } catch (_) { return null }
}

// Deposit check: does `vault` hold ≥ `qtyWhole` of `asset`? (ACME balances are confirmed-only,
// so a present balance means the send settled.)
async function checkDeposit(vault, asset, qtyWhole, dec) {
  const balBase = await addressBalanceBase(vault, asset)
  const need = BigInt(toBase(qtyWhole, dec))
  return { arrived: BigInt(balBase || '0') >= need, balance_base: balBase, balance: fromBase(balBase, dec) }
}

// REDEEM: compose an ACME `send` releasing `qtyWhole` of `asset` from the vault → returns an
// unsigned tx for the vault to sign (via Emblem) + broadcast. GATED upstream by custody-live.
// acme.pics wants `quantity` as a JSON NUMBER (u64), not a string (a string 422s with a plain
// serde error). We guard against JS >2^53 precision loss: base-unit amounts above
// MAX_SAFE_INTEGER are rejected rather than silently mis-sent. (Realistic redemption amounts
// are far below this; revisit with a bigint-safe transport if ever needed.)
async function composeSend({ from, toAddress, asset, qtyWhole, dec }) {
  const quantityStr = toBase(qtyWhole, dec)
  if (BigInt(quantityStr) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`acme compose: quantity ${quantityStr} exceeds JS-safe integer; needs bigint-safe transport`)
  }
  const j = await apPost('/compose/send', { source: from, destination: toAddress, asset, quantity: Number(quantityStr) })
  if (j && j.error) throw new Error(`acme compose: ${j.error}`)
  return j && j.result
}

// ── Phase-1 additions (deposit attribution + confirmation depth) — for review ──

// Per-tx deposit attribution: return the specific confirmed send(s) of `asset` to `vault`,
// optionally constrained by source / min amount / block, so two depositors of the same asset
// can't be conflated. /sends carries tx_hash, source, destination, quantity, block_index, status.
async function findDeposits(asset, vault, { source = null, minQtyBase = null, sinceBlock = null } = {}) {
  let j; try { j = await apGet(`/assets/${encodeURIComponent(asset)}/sends?limit=200`) } catch (_) { return [] }
  const rows = (j && j.result) || []
  return rows.filter(r =>
    r.destination === vault &&
    (r.status === 'valid' || r.status == null) &&
    (source == null || r.source === source) &&
    (minQtyBase == null || BigInt(String(r.quantity || '0')) >= BigInt(minQtyBase)) &&
    (sinceBlock == null || (r.block_index || 0) >= sinceBlock)
  ).map(r => ({
    tx_hash: r.tx_hash, source: r.source, destination: r.destination,
    quantity_base: String(r.quantity), block_index: r.block_index, status: r.status, memo: r.memo || null,
  }))
}

// Confirmation depth of a send's block vs current tip. ACME (like Counterparty) surfaces
// CONFIRMED sends only (status:'valid'); a balance appearing means it's in a block. For custody,
// require N confirmations before crediting to be reorg-safe (CORTEX reorgs undo affected ops).
async function confirmations(blockIndex) {
  const tip = await chainHeight()
  if (!tip || !blockIndex) return 0
  return Math.max(0, tip - blockIndex + 1)
}

module.exports = {
  lookupAsset, addressBalanceBase, checkDeposit, composeSend, chainHeight, sentToVault,
  findDeposits, confirmations,
  fromBase, toBase, acmeDecimals,
}
