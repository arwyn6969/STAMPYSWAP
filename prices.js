// StampySwap — indicative USD/BTC pricing for canonical assets. These are thin, meme-y
// Bitcoin-native markets, so prices are INDICATIVE (last trade / cheapest on-chain ask), not
// deep liquid quotes — surfaced honestly for a "dollar-wise" view. All server-side + cached.
//   SRC-20  → stampchain market API (price_usd, mcap, 24h change, volume, holders)
//   XCP     → cheapest OPEN Counterparty dispenser (satoshi ask) × BTC/USD
const CP = process.env.COUNTERPARTY_API || 'https://api.counterparty.io:4000/v2'
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null }
function timeoutSignal(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal }

const cache = new Map() // key -> { v, t }
async function memo(key, ttl, fn) {
  const c = cache.get(key)
  if (c && Date.now() - c.t < ttl) return c.v
  try { const v = await fn(); cache.set(key, { v, t: Date.now() }); return v }
  catch (_) { return c ? c.v : null } // serve stale on error
}

async function btcUsd() {
  return memo('btcusd', 60000, async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: timeoutSignal(8000) })
    const j = await r.json()
    return (j && j.bitcoin && j.bitcoin.usd) || null
  })
}

// SRC-20 market snapshot (stampchain). tick as indexed (e.g. 'kevin', '$bald' — try as given).
async function src20Market(tick) {
  return memo(`src20:${tick.toLowerCase()}`, 60000, async () => {
    const r = await fetch(`https://stampchain.io/api/v2/src20/market/${encodeURIComponent(tick)}`, { signal: timeoutSignal(8000) })
    if (!r.ok) return null
    const j = await r.json()
    if (!j || (j.price_usd == null && j.market_cap_usd == null)) return null
    const holders = num(j.holder_count)
    return {
      source: 'stampchain-market', price_usd: num(j.price_usd), price_btc: num(j.price_btc),
      market_cap_usd: num(j.market_cap_usd), change_24h: num(j.price_change_24h_percent),
      volume_24h_btc: num(j.volume_24h_btc), holders,
      thin: false, note: (holders != null && holders < 25) ? 'few holders · low liquidity' : null,
    }
  })
}

// Counterparty indicative price: cheapest OPEN dispenser ask × BTC/USD. These are REAL prices
// (people actually pay the satoshirate to trigger a dispense) but often ULTRA-THIN — scarce
// Stamps/XCP assets trade in tiny base-unit fractions, so the whole-unit price is a real but
// extrapolated figure. CRITICAL: quantities are in BASE units for divisible assets, so we use
// `price_normalized` (already BTC per WHOLE unit), NOT raw give_quantity. We surface the price
// with a `thin` flag + note rather than hiding it — the UI warns, and thin markets are kept out
// of the headline TVL so a scarce single-dispenser ask can't distort the aggregate.
async function xcpMarket(asset, btc) {
  return memo(`xcp:${asset}`, 60000, async () => {
    const r = await fetch(`${CP}/assets/${encodeURIComponent(asset)}/dispensers?status=open&verbose=true&limit=50`, { headers: { accept: 'application/json' }, signal: timeoutSignal(8000) })
    if (!r.ok) return null
    const rows = ((await r.json()).result) || []
    const valid = rows.filter(d => Number(d.price_normalized) > 0)  // valid open dispenser with a real ask
    if (!valid.length) return null
    const price_btc = Math.min(...valid.map(d => Number(d.price_normalized)))  // cheapest ask, BTC per whole unit
    const inventory = Math.max(...valid.map(d => Number(d.give_remaining_normalized) || 0))
    return {
      source: 'counterparty-dispenser', price_btc, price_usd: btc ? price_btc * btc : null,
      thin: true, open_dispensers: valid.length, inventory,
      note: 'on-chain dispenser price · ultra-scarce asset, trades in tiny fractions · indicative',
    }
  })
}

// One call: price a canonical asset by protocol. Returns null price fields when no market exists.
async function priceAsset({ tick, protocol }, btc) {
  let m = null
  if (protocol === 'counterparty') m = await xcpMarket(tick, btc)
  else m = await src20Market(tick)
  return m || { source: 'none', price_usd: null, price_btc: null, thin: false, note: null }
}

module.exports = { btcUsd, src20Market, xcpMarket, priceAsset }
