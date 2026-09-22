// StampySwap — Phase 0: canonical registry & SRC-20 discovery.
// READ-ONLY. Touches no collateral. All external calls are server-side (stampchain);
// all DB access goes through the Dashboard API. The browser only calls our own /api/*.
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const nacl = require('tweetnacl')
const bs58 = require('bs58').default // bs58 v6 is ESM; .default in CJS
const solMint = require('./sol-mint') // Phase 4: real Solana devnet mint
const evmMint = require('./evm-mint') // Phase 6: real Base/Ethereum testnet representations
const amm = require('./amm') // Phase 7: native SRC-20/SRC-20 AMM (on-chain constant-product pair)
const custody = require('./custody') // Emblem Vault BTC custody (managed vault address; no raw key)
const counterparty = require('./counterparty') // Counterparty (XCP) asset support
const acme = (() => { try { return require('./acme') } catch (_) { return null } })() // ACME adapter (Phase 0: discovery only, read-only)
const prices = require('./prices') // indicative USD/BTC pricing (SRC-20 market + XCP dispensers)
const recovery = require('./recovery') // durable-recovery decision logic (audit R05/F06) — pure, unit-tested
const labels = require('./labels') // on-chain provenance labels (canonical cross-protocol identity) — pure, unit-tested
const squads = (() => { try { return require('./squads') } catch (_) { return null } })() // Squads v4 multisig (Solana authority upgrade)
const safe = (() => { try { return require('./safe') } catch (_) { return null } })() // Safe multisig (EVM authority upgrade)
const { Verifier: Bip322Verifier } = require('bip322-js') // Phase 5: real BIP-322 proof verification

const app = express()
app.use(express.json({ limit: '64kb' })) // bound request bodies

// ============================================================================
// MAINTENANCE CONTAINMENT — audit 2345961 (repair plan PR1). ONE enforcement point,
// before any DB write or signer call, that disables EVERY value-moving / accounting-
// changing route while the audit remediation is completed. A single choke-point so no
// vulnerable route (incl. legacy intent paths F03) can be forgotten. The operator header
// bypasses for reviewed back-office/repair work. Reads + discovery stay available; the
// already-deployed Uniswap pool keeps trading independently. Toggle: STAMPY_MAINTENANCE=0.
// ============================================================================
const MAINTENANCE = process.env.STAMPY_MAINTENANCE !== '0' // default ON (contained)
let SCHEMA_OK = false // set true once the burn-registry schema is verified at startup (audit R03)
// Normalize a path the way Express 4 DISPATCHES it (case-insensitive routing + optional trailing
// slash + collapsed slashes are all ON by default). Audit R01: a regex blacklist on the raw path
// was bypassable via /API/..., a trailing slash, or //double slashes while Express still routed to
// the same handler. Match on this normalized form everywhere (maintenance, retired, rate-limit).
function normPath(p) { return String(p || '/').toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/' }

// PERMANENTLY RETIRED routes (audit A): legacy fabrication/mutation surfaces removed regardless of
// maintenance/operator/preview — they fabricated accounting or allowed deposit-key replay (F03).
const RETIRED_PATTERNS = [
  /^\/api\/redeem$/,                          // accounting-only burn, no chain effect
  /^\/api\/preview\/confirm-deposit$/,        // fabricates backing under a preview flag
  /^\/api\/bridge\/intent$/,                  // legacy intent create
  /^\/api\/bridge\/intent\/[^/]+$/,           // legacy intent poll (mutates pending→confirmed)
  /^\/api\/bridge\/intent\/[^/]+\/txid$/,     // F03: mutable deposit-txid key
]
app.use((req, res, next) => {
  if (RETIRED_PATTERNS.some(r => r.test(normPath(req.path))))
    return res.status(410).json({ error: 'this legacy endpoint has been retired for safety (audit) — it fabricated accounting or allowed deposit replay' })
  next()
})

// DEFAULT-DENY maintenance containment: block ALL non-GET/HEAD /api requests (every value/accounting
// operation is a POST → nothing to enumerate or bypass), plus any legacy intent GET (which mutates).
// Reads (GET/HEAD) + static files stay available. Operator header = reviewed back-office override.
app.use((req, res, next) => {
  const p = normPath(req.path)
  const isWrite = !(req.method === 'GET' || req.method === 'HEAD')
  const unsafeGet = /^\/api\/bridge\/intent(\/|$)/.test(p)
  const blockedTarget = (isWrite && p.startsWith('/api/')) || unsafeGet
  // HARD schema gate (audit R03): if the burn-registry/operations schema isn't verified, NO writes —
  // NOT even operator — because the safety invariants (consume-once, durable ops) depend on those
  // tables. This precedes the operator bypass on purpose.
  if (!SCHEMA_OK && blockedTarget)
    return res.status(503).json({ maintenance: true, error: 'writes disabled — burn-registry/operations schema or migration not verified (SCHEMA_OK=false)' })
  if (!MAINTENANCE) return next()
  if (isOperator(req)) return next() // operator bypasses MAINTENANCE only; schema is verified above
  if (blockedTarget)
    return res.status(503).json({ maintenance: true, error: 'StampySwap is in maintenance while a security audit is remediated — value-moving and accounting operations are disabled. Existing on-chain balances and Uniswap trading are unaffected.' })
  next()
})

// ---- Rate limiting for state-changing / gas-spending endpoints ----
// LESSON (devnet): the mint/pool/swap endpoints trigger REAL on-chain txs paid by our
// keys. Public + unauthenticated = drainable. Sliding-window limits (global, since all
// traffic arrives via the dashboard proxy) + a global on-chain-op ceiling cap the blast
// radius. On mainnet these become per-authenticated-user quotas.
const _rl = new Map()
function rateLimit(key, max, windowMs) {
  const now = Date.now()
  const arr = (_rl.get(key) || []).filter(t => t > now - windowMs)
  if (arr.length >= max) { _rl.set(key, arr); return false }
  arr.push(now); _rl.set(key, arr); return true
}
const WRITE_LIMITS = {
  'POST /api/mint': [20, 60000],
  'POST /api/redeem': [20, 60000],
  'POST /api/preview/confirm-deposit': [40, 60000],
  'POST /api/amm/create': [5, 600000],
  'POST /api/amm/swap': [30, 60000],
  'POST /api/mint/migrate-authority': [3, 3600000],
  'POST /api/bridge/intent': [40, 60000],
  'POST /api/custody/verify-deposit': [10, 60000],
  'POST /api/custody/redeem': [10, 60000],
  'POST /api/move': [15, 60000],
  'POST /api/stampbridge/execute': [10, 60000],
}
// endpoints that actually spend gas — also counted against a global hourly ceiling
const GAS_OPS = new Set(['POST /api/mint', 'POST /api/amm/create', 'POST /api/amm/swap', 'POST /api/mint/migrate-authority', 'POST /api/custody/verify-deposit', 'POST /api/move', 'POST /api/stampbridge/execute'])
app.use((req, res, next) => {
  const k = `${req.method} ${normPath(req.path)}` // audit R01: match dispatched route, not raw spelling
  const lim = WRITE_LIMITS[k]
  if (lim && !rateLimit('rl:' + k, lim[0], lim[1]))
    return res.status(429).json({ error: 'rate limited — too many requests, slow down' })
  if (GAS_OPS.has(k) && !rateLimit('gas:global', 120, 3600000))
    return res.status(429).json({ error: 'global on-chain op ceiling reached (120/hr) — protects the gas budget' })
  next()
})

// Read-only service status — lets the UI show a maintenance banner + hide unsafe actions.
app.get('/api/status', (_req, res) => res.json({ service: MAINTENANCE ? 'maintenance' : 'live', maintenance: MAINTENANCE,
  message: MAINTENANCE ? 'Security hardening in progress — deposits, mints, moves, redemptions and pool operations are temporarily disabled. Existing balances + Uniswap trading are unaffected.' : 'live' }))

const PORT = process.env.PORT || 3000
const STAMP = 'https://stampchain.io/api/v2'
const DASH = `http://localhost:${process.env.DASHBOARD_PORT || 4000}`
const TOKEN = process.env.DASHBOARD_TOKEN
const GROUP = process.env.ARTIFACT_GROUP || 'kevmart'

// ---- Dashboard DB helpers (server-side only) ----
async function dbQuery(sql, params = []) {
  const u = `${DASH}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}&params=${encodeURIComponent(JSON.stringify(params))}`
  const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (!r.ok) throw new Error(`db query ${r.status}`)
  const j = await r.json()
  return j.rows || j.result || j.data || []
}
async function dbExec(sql, params = []) {
  const r = await fetch(`${DASH}/api/db/${GROUP}/database/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  })
  if (!r.ok) throw new Error(`db exec ${r.status}`)
  return r.json()
}

const now = () => Math.floor(Date.now() / 1000)

// Display form of a ticker WITHOUT mutating or inventing identity. Critically, we NEVER
// synthesize a "$" — so "$" appears ONLY when it is genuinely part of the ticker. This
// keeps "gods" (→ GODS) visibly distinct from a hypothetical "$gods" (→ $GODS), which is
// the whole point of a provenance-first, collision-resistant registry.
//  - "kevin" -> "KEVIN"   (pure word: uppercased for readability, no $)
//  - "gods"  -> "GODS"
//  - "$bald" -> "$BALD"   ($ is part of identity; uppercase the word part after it)
//  - "🙂" / unicode        -> shown EXACTLY as-is (never uppercased, never $-prefixed)
function displayTicker(t) {
  t = String(t || '')
  const isWord = s => /^[a-z0-9]+$/i.test(s)
  if (t.startsWith('$')) { const rest = t.slice(1); return isWord(rest) ? '$' + rest.toUpperCase() : t }
  return isWord(t) ? t.toUpperCase() : t
}
// Cached indexer reads — short TTL. Cuts stampchain load and speeds repeat lookups; a
// deposit's confirmation depth doesn't change faster than blocks (~10min) so 15s is safe.
const _stampCache = new Map() // pathname -> { exp, data }
async function stamp(pathname, ttl = 15000) {
  const hit = _stampCache.get(pathname)
  if (hit && hit.exp > Date.now()) return hit.data
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000)
  let data
  try {
    const r = await fetch(`${STAMP}${pathname}`, { headers: { accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) throw new Error(`stampchain ${r.status}`)
    data = await r.json()
  } finally { clearTimeout(t) }
  _stampCache.set(pathname, { exp: Date.now() + ttl, data })
  if (_stampCache.size > 600) for (const k of _stampCache.keys()) { _stampCache.delete(k); if (_stampCache.size <= 400) break }
  return data
}

// Strict positive-decimal amount validator (bounded). Rejects negatives, NaN, scientific
// notation, absurd sizes — returns the normalized string or null.
function parseAmount(s) {
  if (s == null) return null
  const str = String(s).trim()
  if (!/^\d{1,30}(\.\d{1,18})?$/.test(str)) return null
  return toBaseUnits(str) > 0n ? str : null
}

// Serialize state-changing work per asset (keyed by canonical_id). Closes the
// check-then-mint solvency race: two concurrent mints of the same asset can't both pass
// the collateral check and then both mint. Different assets still run in parallel.
const ethersIsAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''))
const _assetLocks = new Map()
function withAssetLock(id, fn) {
  const prev = _assetLocks.get(id) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  _assetLocks.set(id, next.catch(() => {}))
  return next
}
// GLOBAL Bitcoin-vault lock (audit R05): every custody RELEASE (redeem / stamp-bridge / ACME) spends
// the SAME vault's BTC UTXOs. Per-asset locks don't help — the UTXO pool is shared ACROSS assets, so
// two different assets releasing at once could select the SAME UTXO → a double-spend (one tx dropped,
// funds mis-accounted). Serialize ALL vault broadcasts through this single lock. Nesting order is
// always asset-lock (outer) → btc-lock (inner) around the broadcast, so there is no deadlock.
let _btcVaultLock = Promise.resolve()
function withBtcVaultLock(fn) {
  const next = _btcVaultLock.catch(() => {}).then(fn)
  _btcVaultLock = next.catch(() => {})
  return next
}

// ---- supported chains ----
app.get('/api/chains', async (_req, res) => {
  try {
    const rows = await dbQuery('SELECT chain, display_name, kind, release_gate, live, sort_order FROM supported_chains ORDER BY sort_order')
    res.json({ chains: rows })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ---- discovery: look up a ticker by PROVENANCE, not treat ticker as identity ----
// Discover a Counterparty (XCP) asset, register it (provenance = asset name + issuer), and
// return it in the same shape as an SRC-20 asset (with protocol tagged).
async function discoverCounterparty(raw, res) {
  const stripped = raw.replace(/^\$+/, '')
  const cands = [...new Set([raw, stripped, stripped.toUpperCase()].filter(Boolean))]
  let a = null
  for (const c of cands) { a = await counterparty.lookupAsset(c); if (a) break }
  if (!a) return discoverAcme(raw, cands, res) // Phase 0: try ACME after SRC-20 + Counterparty both miss
  const key = `counterparty:${a.asset}`
  let canonicalId = null
  try {
    const existing = await dbQuery('SELECT id FROM canonical_assets WHERE source_protocol=? AND deploy_tx=?', ['counterparty', key])
    if (existing.length) {
      canonicalId = existing[0].id
      await dbExec('UPDATE canonical_assets SET exact_ticker=?, max_supply=?, minted_supply=?, decimals=?, deployer_address=?, verification_status=?, updated_at=? WHERE id=?',
        [a.asset, a.max_supply, a.max_supply, a.decimals, a.issuer, a.locked ? 'locked' : 'issued', now(), canonicalId])
    } else {
      const ins = await dbExec(`INSERT INTO canonical_assets (source_chain, source_protocol, exact_ticker, deploy_tx, max_supply, minted_supply, decimals, deployer_address, verification_status, canonical_status, first_seen_at, updated_at)
        VALUES ('bitcoin','counterparty',?,?,?,?,?,?,?, 'indexed', ?, ?)`,
        [a.asset, key, a.max_supply, a.max_supply, a.decimals, a.issuer, a.locked ? 'locked' : 'issued', now(), now()])
      canonicalId = ins.lastInsertRowid
    }
  } catch (_) {}
  const chains = await dbQuery('SELECT chain, display_name, kind, release_gate FROM supported_chains ORDER BY sort_order')
  const reps = canonicalId != null ? await dbQuery('SELECT dest_chain, status, dest_address, circulating_supply FROM representations WHERE canonical_id=?', [canonicalId]) : []
  const repByChain = Object.fromEntries(reps.map(r => [r.dest_chain, r]))
  res.json({ found: true, query: raw, asset: {
    source_chain: 'bitcoin', source_protocol: 'counterparty', protocol_label: 'Counterparty (XCP)',
    exact_ticker: a.asset, display: a.asset, longname: a.longname, deployer_address: a.issuer, deploy_tx: null,
    max_supply: a.max_supply, minted_supply: a.max_supply, decimals: a.decimals, divisible: a.divisible,
    holder_count: null, verification_status: a.locked ? 'locked · fully issued' : 'issued', canonical_id: canonicalId,
    representations: chains.map(c => { const r = repByChain[c.chain]; return { chain: c.chain, display_name: c.display_name, kind: c.kind, release_gate: !!c.release_gate, status: (r && r.status) || 'NOT_DEPLOYED', dest_address: (r && r.dest_address) || null, circulating_supply: (r && r.circulating_supply) || '0' } }),
  } })
}

// ACME protocol adapter (Phase 0 — registry/discovery ONLY, read-only). Tried after SRC-20 +
// Counterparty both miss. Writes source_protocol='acme'; deliberately NOT whitelisted, and inert
// beyond the registry (an acme asset can't flow through the SRC-20/XCP deposit or mint paths, so
// there is zero value at risk). Mirrors the counterparty branch exactly. Adapter reviewed + tested.
async function discoverAcme(raw, cands, res) {
  if (!acme) return res.json({ found: false, query: raw, message: `No SRC-20 or Counterparty asset "${raw}" found.` })
  let a = null
  for (const c of cands) { try { a = await acme.lookupAsset(c) } catch (_) { a = null } if (a) break }
  if (!a) return res.json({ found: false, query: raw, message: `No SRC-20, Counterparty, or ACME asset "${raw}" found. Check the exact name/characters.` })
  const key = `acme:${a.asset}`
  let canonicalId = null
  try {
    const existing = await dbQuery('SELECT id FROM canonical_assets WHERE source_protocol=? AND deploy_tx=?', ['acme', key])
    if (existing.length) {
      canonicalId = existing[0].id
      await dbExec('UPDATE canonical_assets SET exact_ticker=?, max_supply=?, minted_supply=?, decimals=?, deployer_address=?, verification_status=?, updated_at=? WHERE id=?',
        [a.asset, a.max_supply, a.max_supply, a.decimals, a.issuer, a.locked ? 'locked' : 'issued', now(), canonicalId])
    } else {
      const ins = await dbExec(`INSERT INTO canonical_assets (source_chain, source_protocol, exact_ticker, deploy_tx, max_supply, minted_supply, decimals, deployer_address, verification_status, canonical_status, first_seen_at, updated_at)
        VALUES ('bitcoin','acme',?,?,?,?,?,?,?, 'indexed', ?, ?)`,
        [a.asset, key, a.max_supply, a.max_supply, a.decimals, a.issuer, a.locked ? 'locked' : 'issued', now(), now()])
      canonicalId = ins.lastInsertRowid
    }
  } catch (_) {}
  const chains = await dbQuery('SELECT chain, display_name, kind, release_gate FROM supported_chains ORDER BY sort_order')
  const reps = canonicalId != null ? await dbQuery('SELECT dest_chain, status, dest_address, circulating_supply FROM representations WHERE canonical_id=?', [canonicalId]) : []
  const repByChain = Object.fromEntries(reps.map(r => [r.dest_chain, r]))
  res.json({ found: true, query: raw, asset: {
    source_chain: 'bitcoin', source_protocol: 'acme', protocol_label: 'ACME',
    exact_ticker: a.asset, display: a.asset, longname: a.longname, deployer_address: a.issuer, deploy_tx: key,
    max_supply: a.max_supply, minted_supply: a.max_supply, decimals: a.decimals, divisible: a.divisible,
    holder_count: null, verification_status: a.locked ? 'locked · fully issued' : 'issued', canonical_id: canonicalId,
    representations: chains.map(c => { const r = repByChain[c.chain]; return { chain: c.chain, display_name: c.display_name, kind: c.kind, release_gate: !!c.release_gate, status: (r && r.status) || 'NOT_DEPLOYED', dest_address: (r && r.dest_address) || null, circulating_supply: (r && r.circulating_supply) || '0' } }),
  } })
}

app.get('/api/discover', async (req, res) => {
  let raw = String(req.query.tick || '').trim()
  if (!raw) return res.status(400).json({ error: 'ticker required' })
  // Optional PROTOCOL QUALIFIER to disambiguate ticker COLLISIONS across protocols — the same
  // name can exist on SRC-20, Counterparty AND ACME (e.g. SOAP). Without it the cascade order
  // (src-20 → counterparty → acme) wins, shadowing later protocols. Supply via ?protocol=acme
  // or a "proto:TICKER" prefix (acme:SOAP). Forcing a protocol runs that branch directly.
  let protocol = String(req.query.protocol || '').toLowerCase().trim()
  const pfx = raw.match(/^(acme|counterparty|xcp|src-?20)\s*:\s*(.+)$/i)
  if (pfx) { protocol = pfx[1].toLowerCase().replace('xcp', 'counterparty').replace(/^src-?20$/, 'src-20'); raw = pfx[2].trim() }
  // CRITICAL (spec §2): the leading "$" may be PART of the asset identity (e.g. "$BALD"),
  // not a display convention. So try the ticker exactly as typed FIRST, then a stripped
  // form, then a "$"-prefixed form — first real on-chain hit wins, preserving user intent.
  const stripped = raw.replace(/^\$+/, '')
  const candidates = [...new Set([raw, stripped, '$' + stripped].filter(Boolean))]
  if (protocol === 'acme') return discoverAcme(raw, candidates, res)          // force ACME branch
  if (protocol === 'counterparty') return discoverCounterparty(raw, res)       // force Counterparty (→ acme on miss)
  try {
    // 1) resolve against the index — mint_status carries supply, decimals & the deploy tx
    let tick = null, status = null, ms = null
    for (const cand of candidates) {
      try { // stampchain returns 4xx for unknown/invalid ticks — treat as "not this candidate", not a server error
        const resp = await stamp(`/src20/tick/${encodeURIComponent(cand)}`)
        const s = resp && resp.mint_status
        if (s && s.tx_hash) { tick = cand; status = s; ms = resp; break }
      } catch (_) { /* invalid/unknown for this candidate → try the next */ }
    }
    if (!status) {
      // Not an SRC-20 asset — try Counterparty (XCP) before giving up.
      return discoverCounterparty(raw, res)
    }
    const deployTxAuthoritative = status.tx_hash // mint_status.tx_hash IS the deploy tx — the source of truth

    // 2) the DEPLOY op enriches provenance (deployer/block/time) — BUT the indexer's tick
    // filter is unreliable for emoji/unicode tickers (it can return an UNRELATED token's
    // deploy). So only trust the row if its deploy tx matches the authoritative one.
    let deploy = null
    try {
      const d = await stamp(`/src20?op=DEPLOY&tick=${encodeURIComponent(tick)}&limit=5`)
      const rows = (d && (d.data || d.result)) || []
      deploy = rows.find(r => (r.deploy_tx === deployTxAuthoritative || r.tx_hash === deployTxAuthoritative)) || null
    } catch (_) { /* non-fatal */ }

    const exactTicker = (deploy && deploy.tick) || (ms.data && ms.data[0] && ms.data[0].tick) || tick
    const deployTx = status.tx_hash
    const holders = (ms.data && ms.data[0] && ms.data[0].holders) || null

    const asset = {
      source_chain: 'bitcoin',
      source_protocol: 'src-20', protocol_label: 'Bitcoin SRC-20',
      exact_ticker: exactTicker,       // as indexed on Bitcoin — the immutable source identity
      display: displayTicker(exactTicker),
      deploy_tx: deployTx,             // canonical provenance key (NOT the ticker)
      deploy_block: deploy ? deploy.block_index : null,
      deploy_time: deploy ? deploy.block_time : null,
      deployer_address: deploy ? deploy.creator : null,
      max_supply: status.max_supply,
      minted_supply: status.total_minted,
      mint_limit: status.limit,
      decimals: status.decimals,
      total_mints: status.total_mints,
      progress: status.progress,
      holder_count: holders,
      verification_status: status.progress === '100' ? 'fully-minted' : 'minting',
    }

    // 3) upsert into the canonical registry (provenance-keyed)
    let canonicalId = null
    try {
      const existing = await dbQuery(
        'SELECT id FROM canonical_assets WHERE source_chain=? AND source_protocol=? AND deploy_tx=?',
        ['bitcoin', 'src-20', deployTx])
      if (existing.length) {
        canonicalId = existing[0].id
        await dbExec(`UPDATE canonical_assets SET exact_ticker=?, max_supply=?, mint_limit=?, decimals=?,
          minted_supply=?, holder_count=?, deployer_address=?, deploy_block=?, verification_status=?, updated_at=? WHERE id=?`,
          [exactTicker, asset.max_supply, asset.mint_limit, asset.decimals, asset.minted_supply,
           asset.holder_count, asset.deployer_address, asset.deploy_block, asset.verification_status, now(), canonicalId])
      } else {
        const ins = await dbExec(`INSERT INTO canonical_assets
          (source_chain, source_protocol, exact_ticker, deploy_tx, deploy_block, max_supply, mint_limit, decimals,
           minted_supply, holder_count, deployer_address, verification_status, canonical_status, first_seen_at, updated_at)
          VALUES ('bitcoin','src-20',?,?,?,?,?,?,?,?,?,?, 'indexed', ?, ?)`,
          [exactTicker, deployTx, asset.deploy_block, asset.max_supply, asset.mint_limit, asset.decimals,
           asset.minted_supply, asset.holder_count, asset.deployer_address, asset.verification_status, now(), now()])
        canonicalId = ins.lastInsertRowid
      }
    } catch (e) { /* registry write is best-effort in Phase 0 */ }
    asset.canonical_id = canonicalId

    // 4) representation status per supported chain
    const chains = await dbQuery('SELECT chain, display_name, kind, release_gate, live FROM supported_chains ORDER BY sort_order')
    let reps = []
    if (canonicalId != null) {
      reps = await dbQuery('SELECT dest_chain, status, dest_address, dest_symbol, circulating_supply FROM representations WHERE canonical_id=?', [canonicalId])
    }
    const repByChain = Object.fromEntries(reps.map(r => [r.dest_chain, r]))
    asset.representations = chains.map(c => {
      const r = repByChain[c.chain]
      return {
        chain: c.chain, display_name: c.display_name, kind: c.kind, release_gate: !!c.release_gate,
        status: (r && r.status) || 'NOT_DEPLOYED',
        dest_address: (r && r.dest_address) || null,
        circulating_supply: (r && r.circulating_supply) || '0',
      }
    })

    res.json({ found: true, query: raw, asset })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

// ---- registry listing (assets we've indexed so far) ----
app.get('/api/registry', async (_req, res) => {
  try {
    const rows = await dbQuery(`SELECT id, exact_ticker, deploy_tx, max_supply, minted_supply, decimals,
      holder_count, verification_status, whitelisted FROM canonical_assets
      ORDER BY whitelisted DESC, holder_count DESC LIMIT 100`)
    res.json({ assets: rows })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

app.get('/api/health', async (_req, res) => {
  try { const h = await stamp('/health'); res.json({ ok: true, indexer: h.status }) }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }) }
})

// ============================================================================
// Phase 1 — Wallet connection layer (ownership proof, no collateral)
// ============================================================================
// Short-lived nonces. In-memory is fine for devnet; a shared store comes with
// the relayer. Never trust a client-claimed address without a matching signature.
const nonces = new Map() // nonce -> { role, exp }
const NONCE_TTL = 5 * 60 * 1000
const NONCE_MAX = 10000
function issueNonce(role) {
  const now = Date.now()
  // Bound the store so spamming the (public) nonce endpoint can't grow it unbounded → OOM.
  // Prune expired first; if still over the cap, evict oldest (Map keeps insertion order).
  if (nonces.size > NONCE_MAX) {
    for (const [k, v] of nonces) if (v.exp < now) nonces.delete(k)
    while (nonces.size > NONCE_MAX) { const k = nonces.keys().next().value; if (k === undefined) break; nonces.delete(k) }
  }
  const nonce = crypto.randomBytes(24).toString('hex')
  nonces.set(nonce, { role, exp: now + NONCE_TTL })
  return nonce
}
function takeNonce(nonce) {
  const n = nonces.get(nonce)
  if (!n) return null
  nonces.delete(nonce) // single-use
  if (n.exp < Date.now()) return null
  return n
}
// The exact human-readable message the wallet is asked to sign.
function authMessage(nonce) {
  return `StampySwap wallet verification\nNonce: ${nonce}\nSign to prove you control this address. This is free and does not authorize any transaction.`
}

// DEPOSIT BINDING — the depositor signs this with the SOURCE Bitcoin address (the address that
// made the on-chain deposit), authorizing the mint to a specific receive address. Verifying it
// (BIP-322) + matching the on-chain source closes deposit front-running: an observer who merely
// sees the deposit can't produce this signature, so they can't claim the mint to their own address.
function depositBindingMessage({ source, receive, tick, amount }) {
  return `StampySwap deposit authorization\nSource: ${source}\nReceive: ${receive}\nAsset: ${tick}\nAmount: ${amount}\nI control the source Bitcoin address and authorize minting this deposit to the receive address above.`
}
// Optional back-office override so the operator can credit deposits without a user signature during
// the current single-operator phase. From env OPERATOR_TOKEN or a local .operator-token file
// (server-side, not web-served). Unset → binding is REQUIRED for everyone (the secure default).
const _fs = require('fs')
function operatorToken() {
  try { const f = path.join(__dirname, '.operator-token'); if (_fs.existsSync(f)) return _fs.readFileSync(f, 'utf8').trim() } catch (_) {}
  return process.env.OPERATOR_TOKEN || null
}
// Constant-time string compare (audit: operator-token check must not leak length/prefix via early-exit
// `===`). Returns false on any length mismatch (timingSafeEqual throws on unequal-length buffers).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a)), bb = Buffer.from(String(b == null ? '' : b))
  if (ba.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ba, bb) } catch (_) { return false }
}
// A request is "operator" if it carries the matching token. Used to gate PROTOCOL-FUNDED actions
// (direct mint, pool seeding) that spend protocol gas / mint against protocol collateral — those
// must never be publicly callable (an attacker could mint themselves free backed reps, or drain gas).
function isOperator(req) { const t = operatorToken(); const h = req.headers['x-operator-token']; return !!(t && h && safeEqual(h, t)) }
// Solana mint authority mode: 'emblem' (single managed signer, default) or 'squads' (M-of-N
// multisig). Togglable via env SOLANA_AUTHORITY or a .solana-authority file (server-side, 404 web).
function solanaAuthorityMode() {
  try { const f = path.join(__dirname, '.solana-authority'); if (_fs.existsSync(f)) return _fs.readFileSync(f, 'utf8').trim() } catch (_) {}
  return process.env.SOLANA_AUTHORITY || 'emblem'
}
// EVM mint authority mode: 'emblem' (default) or 'safe' (Gnosis Safe M-of-N). Togglable.
function evmAuthorityMode() {
  try { const f = path.join(__dirname, '.evm-authority'); if (_fs.existsSync(f)) return _fs.readFileSync(f, 'utf8').trim() } catch (_) {}
  return process.env.EVM_AUTHORITY || 'emblem'
}
function requireOperator(req, res) {
  if (isOperator(req)) return false
  res.status(403).json({ error: 'protocol/operator action — not publicly callable. Public flows: deposit→mint (wallet-bound), redeem, cross-chain move (burn-verified).' })
  return true
}

app.get('/api/auth/nonce', (req, res) => {
  const role = String(req.query.role || 'receive')
  const nonce = issueNonce(role)
  res.json({ nonce, message: authMessage(nonce) })
})

// Solana / receive side — REAL ed25519 verification.
app.post('/api/auth/verify-solana', async (req, res) => {
  try {
    const { address, signature, nonce, wallet } = req.body || {}
    if (!address || !signature || !nonce) return res.status(400).json({ error: 'address, signature, nonce required' })
    const n = takeNonce(nonce)
    if (!n) return res.status(400).json({ verified: false, error: 'nonce invalid or expired' })
    let pub, sig
    try { pub = bs58.decode(address); sig = bs58.decode(signature) } catch (_) { return res.status(400).json({ verified: false, error: 'bad base58 encoding' }) }
    if (pub.length !== 32) return res.status(400).json({ verified: false, error: 'bad public key length' })
    const msg = new TextEncoder().encode(authMessage(nonce))
    const ok = nacl.sign.detached.verify(msg, sig, pub)
    if (!ok) return res.json({ verified: false, error: 'signature does not match' })
    try {
      await dbExec(`INSERT INTO wallet_sessions (role, chain, wallet, address, verified, nonce, created_at)
        VALUES (?, 'solana', ?, ?, 1, ?, ?)`, [n.role, wallet || null, address, nonce, now()])
    } catch (_) {}
    res.json({ verified: true, address, chain: 'solana', role: n.role })
  } catch (e) { res.status(500).json({ verified: false, error: String(e.message || e) }) }
})

// Bitcoin / deposit side — Wonder Wallet returns a BIP-322 proof at connect.
// We record it now; full server-side BIP-322 verification is done by the deposit
// relayer (Phase 2), where it belongs alongside the on-chain deposit check.
// Bitcoin ownership proof — REAL BIP-322 verification (Phase 5) over a single-use nonce.
// The wallet signs authMessage(nonce); we verify the signature belongs to the address.
app.post('/api/auth/verify-bitcoin', async (req, res) => {
  try {
    const { address, signature, nonce, proof, wallet } = req.body || {}
    if (!address) return res.status(400).json({ error: 'address required' })
    let verified = false, method = 'none', reason = null
    const sig = signature || (proof && proof.signature)
    if (sig && nonce) {
      const n = takeNonce(nonce) // single-use
      if (!n) { reason = 'nonce invalid or expired' }
      else {
        try { verified = Bip322Verifier.verifySignature(address, authMessage(nonce), String(sig)); method = 'bip322' }
        catch (e) { verified = false; reason = 'signature could not be verified' }
        if (!verified && !reason) reason = 'signature does not match address'
      }
    } else { reason = 'signature + nonce required for verification' }
    try {
      await dbExec(`INSERT INTO wallet_sessions (role, chain, wallet, address, verified, proof, nonce, created_at)
        VALUES ('deposit', 'bitcoin', ?, ?, ?, ?, ?, ?)`,
        [wallet || 'wonder', address, verified ? 1 : 0, sig ? String(sig).slice(0, 400) : null, nonce || null, now()])
    } catch (_) {}
    res.json({ verified, method, address, chain: 'bitcoin',
      note: verified ? 'Bitcoin address ownership verified via BIP-322.' : ('not verified' + (reason ? ': ' + reason : '')) })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// EVM (Base/Ethereum) address ownership — verify a personal_sign of the nonce via ethers.
const _ethers = require('ethers')
app.post('/api/auth/verify-evm', async (req, res) => {
  try {
    const { address, signature, nonce, wallet } = req.body || {}
    if (!address || !signature || !nonce) return res.status(400).json({ verified: false, error: 'address, signature, nonce required' })
    const n = takeNonce(nonce) // single-use
    if (!n) return res.status(400).json({ verified: false, error: 'nonce invalid or expired' })
    let verified = false
    try { verified = _ethers.verifyMessage(authMessage(nonce), String(signature)).toLowerCase() === String(address).toLowerCase() } catch (_) {}
    try {
      await dbExec(`INSERT INTO wallet_sessions (role, chain, wallet, address, verified, nonce, created_at) VALUES ('receive-evm', 'evm', ?, ?, ?, ?, ?)`,
        [wallet || 'evm', address, verified ? 1 : 0, nonce || null, now()])
    } catch (_) {}
    res.json({ verified, address, chain: 'evm', note: verified ? 'EVM address ownership verified (personal_sign).' : 'not verified: signature does not match address' })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ============================================================================
// Phase 2 — Deposit intents + BTC deposit-verification relayer
// ============================================================================
// LIVE. The app now has REAL Emblem-Vault custody (BTC mainnet), REAL deposit→mint→redeem
// (Solana devnet + Base/Ethereum Sepolia mints, all unconditional — never simulated), and a
// live proof-of-reserves. PREVIEW is therefore OFF by default: the old preview messaging
// ("nothing minted / do not send / simulated") is false now, and the preview-only
// confirm-deposit hook (which fabricated collateral) is disabled so it can't inject fake
// backing into real assets. Set STAMPY_PREVIEW=1 only to re-enable the sandbox sim hooks.
const PREVIEW = String(process.env.STAMPY_PREVIEW || process.env.STAMPY_DEVNET || '0') !== '0'
const CONFIRMS = parseInt(process.env.DEPOSIT_CONFIRMATIONS || '2', 10)
// The stamp bridge burns SRC-20 IRREVERSIBLY and releases a stamp — a reorg that un-burns after
// release would be a double-spend, so it requires deeper burial than a normal (reversible) deposit.
const STAMP_BRIDGE_CONFIRMS = parseInt(process.env.STAMP_BRIDGE_CONFIRMATIONS || '3', 10)
// ACME (acme.pics) deposit finality — acme.pics surfaces confirmed sends only, but we still gate
// on N confirmations to be reorg-safe (CORTEX reorgs undo affected ops). Configurable.
const ACME_CONFIRMS = parseInt(process.env.ACME_CONFIRMATIONS || '3', 10) // P1 (audit): ≥3 on mainnet wraps
// Custody deposit address = the Emblem vault's managed BTC address (resolved at startup).
// Real, managed, no raw key. Deposit SOLICITATION stays gated (custody.CUSTODY_LIVE) until audit.
let VAULT_ADDR = process.env.VAULT_DEPOSIT_ADDRESS || null
custody.depositAddress().then(a => { if (a) { VAULT_ADDR = a; console.log('custody address (Emblem vault):', a) } }).catch(() => {})

// SRC-20 amounts are decimal strings (up to 18 dp). Scale to integer base units so we
// can compare exactly with BigInt — never Number() (precision) and never BigInt() a
// string with a '.' (throws). "150000000.0000…" and "1" both normalize correctly.
function toBaseUnits(s, decimals = 18) {
  let str = String(s == null ? '0' : s).trim()
  if (!str) return 0n
  const neg = str.startsWith('-'); if (neg) str = str.slice(1)
  let [i, f = ''] = str.split('.')
  i = i.replace(/[^0-9]/g, '') || '0'
  f = (f.replace(/[^0-9]/g, '') + '0'.repeat(decimals)).slice(0, decimals)
  const v = BigInt(i + f)
  return neg ? -v : v
}

// Core relayer check — READ-ONLY. Given a tick, a destination (vault) address and an
// expected minimum amount, determine whether the SRC-20 has arrived and how confirmed.
async function checkDeposit(tick, destAddr, expectedAmt, txid) {
  const out = { arrived: false, confirmed: false, balance: '0', confirmations: 0, height: null, deposit_block: null, txid: txid || null }
  if (!destAddr) return out
  // chain height
  try { const h = await stamp('/health'); out.height = h && h.services && h.services.blockSync && h.services.blockSync.indexed || null } catch (_) {}
  // 1) current SRC-20 balance at the destination (cumulative)
  try {
    const b = await stamp(`/src20/balance/${encodeURIComponent(destAddr)}`)
    const rows = (b && (b.data || b.result)) || []
    const row = rows.find(r => String(r.tick).toLowerCase() === String(tick).toLowerCase())
    if (row) out.balance = String(row.amt != null ? row.amt : (row.balance || '0'))
  } catch (_) {}
  // 2) locate the specific TRANSFER (for block height / confirmations / txid match)
  try {
    const d = await stamp(`/src20?op=TRANSFER&tick=${encodeURIComponent(tick)}&limit=500`)
    const rows = (d && (d.data || d.result)) || []
    const matches = rows.filter(r => r.destination === destAddr && (!txid || r.tx_hash === txid))
    if (matches.length) {
      const blk = Math.max(...matches.map(m => m.block_index || 0))
      out.deposit_block = blk || null
      if (out.height && blk) out.confirmations = Math.max(0, out.height - blk + 1)
    }
  } catch (_) {}
  // arrival = enough balance landed; confirmed = arrived AND enough confirmations
  try { out.arrived = toBaseUnits(out.balance) >= toBaseUnits(expectedAmt) } catch (_) { out.arrived = false }
  out.confirmed = out.arrived && out.confirmations >= CONFIRMS
  return out
}

// Relayer inspector (read-only, safe) — run the deposit check against ANY tick+address.
// Lets us test/demonstrate the verification pipeline without any real deposit.
app.get('/api/bridge/inspect', async (req, res) => {
  try {
    const tick = String(req.query.tick || '').replace(/^\$+/, '')
    const addr = String(req.query.addr || '')
    const amt = String(req.query.amount || '0')
    if (!tick || !addr) return res.status(400).json({ error: 'tick and addr required' })
    res.json({ tick, addr, expected: amt, threshold: CONFIRMS, result: await checkDeposit(tick, addr, amt, req.query.txid) })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Precise, txid-attributed deposit verification (Phase 5). Deterministic per deposit —
// no scanning. Also REORG-SAFE: state is re-derived from current chain state each call,
// so if a tx is reorged out of the SRC-20 index it stops being 'confirmed' automatically.
async function verifyDepositTxid(txid, tick, expectedAmt, vaultAddr) {
  const out = { found: false, valid: false, confirmed: false, confirmations: 0, op: null, tick: null, source: null, destination: null, amt: '0', block: null, height: null, reason: null }
  let d
  try { d = await stamp(`/src20/tx/${encodeURIComponent(txid)}`) }
  catch (_) { out.reason = 'txid not in the SRC-20 index (unconfirmed, non-SRC-20, or reorged out)'; return out }
  const data = d && (d.data || d.result)
  out.height = (d && d.last_block) || null
  if (!data || !data.tx_hash) { out.reason = 'no SRC-20 op at that txid'; return out }
  out.found = true; out.op = data.op; out.tick = data.tick; out.source = data.creator; out.destination = data.destination; out.amt = String(data.amt); out.block = data.block_index
  if (String(data.op).toUpperCase() !== 'TRANSFER') { out.reason = 'not a TRANSFER op'; return out }
  if (String(data.tick).toLowerCase() !== String(tick).toLowerCase()) { out.reason = `ticker mismatch (tx is ${data.tick})`; return out }
  if (vaultAddr && data.destination !== vaultAddr) { out.reason = 'destination is not the vault address'; return out }
  if (toBaseUnits(data.amt) < toBaseUnits(expectedAmt)) { out.reason = 'amount below expected'; return out }
  out.valid = true
  if (out.height && out.block) out.confirmations = Math.max(0, out.height - out.block + 1)
  out.confirmed = out.confirmations >= CONFIRMS
  return out
}

// Test/demo the txid path against real historical transfers (read-only).
app.get('/api/bridge/inspect-txid', async (req, res) => {
  try {
    const txid = String(req.query.txid || ''), tick = String(req.query.tick || '').replace(/^\$+/, '')
    if (!txid || !tick) return res.status(400).json({ error: 'txid and tick required' })
    res.json({ txid, threshold: CONFIRMS, result: await verifyDepositTxid(txid, tick, String(req.query.amount || '0'), req.query.addr || null) })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

app.get('/api/bridge/config', (_req, res) => {
  res.json({ mode: PREVIEW ? 'preview' : 'live', preview: PREVIEW, confirmations: CONFIRMS, vault_provisioned: !!VAULT_ADDR,
    note: PREVIEW ? 'PREVIEW — SRC-20/Bitcoin Stamps has no testnet, so the relayer verifies REAL mainnet deposits read-only. No custody address is provisioned, so nothing is solicited or minted.' : 'live' })
})

// Create a deposit intent (state machine row; assigns a vault address only if provisioned).
app.post('/api/bridge/intent', async (req, res) => {
  // Legacy Phase-2 intent flow. The real deposit path is the wallet-bound verify-deposit; intents
  // never auto-credit (they stay 'detected'), so keep this operator-only to avoid a misleading path.
  if (requireOperator(req, res)) return
  try {
    const { tick, amount, deposit_address, receive_address } = req.body || {}
    if (!tick || !amount) return res.status(400).json({ error: 'tick and amount required' })
    if (!receive_address) return res.status(400).json({ error: 'a verified Solana receive address is required' })
    const clean = String(tick).replace(/^\$+/, '')
    const assets = await dbQuery('SELECT id, exact_ticker, whitelisted FROM canonical_assets WHERE lower(exact_ticker)=lower(?) OR lower(exact_ticker)=lower(?)', [clean, '$' + clean])
    const asset = assets[0]
    if (!asset) return res.status(404).json({ error: 'asset not in registry — discover it first' })
    if (!asset.whitelisted) return res.status(403).json({ error: 'asset is not on the supported whitelist' })
    const ins = await dbExec(`INSERT INTO collateral_ledger
      (canonical_id, direction, amount, dest_chain, vault_address, status, created_at)
      VALUES (?, 'deposit', ?, 'solana', ?, 'pending', ?)`,
      [asset.id, String(amount), VAULT_ADDR, now()])
    res.json({
      intent_id: ins.lastInsertRowid, tick: asset.exact_ticker, amount: String(amount),
      vault_address: VAULT_ADDR, receive_address, deposit_address: deposit_address || null,
      preview: PREVIEW, confirmations_required: CONFIRMS,
      instruction: PREVIEW
        ? 'PREVIEW: custody address not provisioned — do not send. The relayer is verifiable via /api/bridge/inspect.'
        : `Send exactly ${amount} ${asset.exact_ticker} to ${VAULT_ADDR}. The relayer will credit it after ${CONFIRMS} confirmations.`
    })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Poll a deposit intent — runs the live relayer check.
app.get('/api/bridge/intent/:id', async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT cl.*, ca.exact_ticker FROM collateral_ledger cl
      JOIN canonical_assets ca ON ca.id = cl.canonical_id WHERE cl.id = ?`, [req.params.id])
    const it = rows[0]
    if (!it) return res.status(404).json({ error: 'intent not found' })
    let check = null, newStatus = it.status, confs = it.confirmations || 0
    if (it.btc_txid) { // precise, reorg-safe txid attribution
      check = await verifyDepositTxid(it.btc_txid, it.exact_ticker, it.amount, it.vault_address)
      confs = check.confirmations
      newStatus = check.confirmed ? 'confirmed' : (check.valid ? 'detected' : 'pending')
    } else if (it.vault_address) { // fallback: address-balance check
      check = await checkDeposit(it.exact_ticker, it.vault_address, it.amount, it.btc_txid)
      confs = check.confirmations
      newStatus = check.confirmed ? 'confirmed' : (check.arrived ? 'detected' : 'pending')
    }
    if (newStatus !== it.status || confs !== it.confirmations) {
      await dbExec('UPDATE collateral_ledger SET status=?, confirmations=? WHERE id=?', [newStatus, confs, it.id]).catch(() => {})
      it.status = newStatus
    }
    res.json({ intent_id: it.id, tick: it.exact_ticker, amount: it.amount, status: it.status, txid: it.btc_txid || null,
      vault_address: it.vault_address, preview: PREVIEW, confirmations_required: CONFIRMS, check })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Record the broadcast txid of a deposit. IDEMPOTENT: a txid can credit only ONE intent
// (prevents replay / double-credit across intents).
app.post('/api/bridge/intent/:id/txid', async (req, res) => {
  try {
    const { txid } = req.body || {}
    if (!txid) return res.status(400).json({ error: 'txid required' })
    const dup = await dbQuery('SELECT id FROM collateral_ledger WHERE btc_txid=? AND id!=?', [String(txid), req.params.id])
    if (dup.length) return res.status(409).json({ error: 'txid already used to credit another deposit', other_intent: dup[0].id })
    const r = await dbExec('UPDATE collateral_ledger SET btc_txid=? WHERE id=? AND direction=\'deposit\'', [String(txid), req.params.id])
    res.json({ updated: r.changes > 0, txid })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Lightweight background sweep — only touches PENDING/DETECTED intents; no-op when idle.
let sweeping = false
async function relayerSweep() {
  return // audit A: legacy intent sweep PERMANENTLY disabled (mutated pending records) — intents retired
  if (sweeping) return
  sweeping = true
  try {
    const pend = await dbQuery(`SELECT cl.id, cl.amount, cl.vault_address, cl.btc_txid, cl.status, cl.confirmations, ca.exact_ticker
      FROM collateral_ledger cl JOIN canonical_assets ca ON ca.id=cl.canonical_id
      WHERE cl.direction='deposit' AND cl.status IN ('pending','detected') AND (cl.btc_txid IS NOT NULL OR cl.vault_address IS NOT NULL) LIMIT 10`)
    for (const it of pend) {
      let ns, confs
      if (it.btc_txid) { const c = await verifyDepositTxid(it.btc_txid, it.exact_ticker, it.amount, it.vault_address); confs = c.confirmations; ns = c.confirmed ? 'confirmed' : (c.valid ? 'detected' : 'pending') }
      else { const c = await checkDeposit(it.exact_ticker, it.vault_address, it.amount, it.btc_txid); confs = c.confirmations; ns = c.confirmed ? 'confirmed' : (c.arrived ? 'detected' : 'pending') }
      if (ns !== it.status || confs !== it.confirmations) await dbExec('UPDATE collateral_ledger SET status=?, confirmations=? WHERE id=?', [ns, confs, it.id]).catch(() => {})
    }
  } catch (_) {} finally { sweeping = false }
}
setInterval(relayerSweep, 60000).unref?.()

// ============================================================================
// Phase 3 — Deposit-gated mint accounting + solvency invariant + proof-of-reserves
// ============================================================================
// PREVIEW: the on-chain Solana mint is SIMULATED (a deterministic devnet-style mint
// address + simulated signature). Real on-chain minting via an AUDITED MULTISIG mint
// authority is a later, reviewed phase. BUT the accounting here is REAL and the core
// solvency invariant is strictly enforced in code:
//        circulating(representation)  ≤  confirmed collateral  ≤  source max supply
// Every mint rounds the amount DOWN to the destination chain's precision, so a
// representation can never exceed its backing. Nothing here can over-issue.
const DEST_DECIMALS = { solana: 9, base: 18, ethereum: 18, 'base-mainnet': 18 } // SPL conventionally ≤9; EVM 18
// SPL token amounts are u64. Large-supply SRC-20 tokens overflow at 9 dp, so pick the
// largest decimals ≤9 where the WHOLE max supply still fits in u64 (e.g. BOSHI 540B → 7dp).
const U64_MAX = (1n << 64n) - 1n
function solanaDecimalsFor(maxSupplyWhole) {
  let supply = BigInt(String(maxSupplyWhole || '1').split('.')[0].replace(/[^0-9]/g, '') || '1')
  if (supply < 1n) supply = 1n
  let dec = DEST_DECIMALS.solana
  while (dec > 0 && supply * (10n ** BigInt(dec)) > U64_MAX) dec--
  return dec
}

function fromBaseUnits(bi, dp = 4) {
  const neg = bi < 0n; let s = (neg ? -bi : bi).toString().padStart(19, '0')
  let intp = s.slice(0, -18).replace(/^0+(?=\d)/, ''), frac = s.slice(-18).slice(0, dp).replace(/0+$/, '')
  return (neg ? '-' : '') + intp + (frac ? '.' + frac : '')
}
// Round a decimal amount DOWN to `decimals` places (protects the solvency invariant).
function floorToDecimals(amountStr, decimals) {
  const s = String(amountStr || '0').trim()
  const [i, f = ''] = s.split('.')
  const fr = f.slice(0, decimals)
  return fr.length ? `${i}.${fr}` : i
}
function mintAddressFor(canonicalId, chain) {
  const h = crypto.createHash('sha256').update(`stampyswap:${chain}:${canonicalId}`).digest()
  return bs58.encode(h) // 32 bytes → valid-length base58 (PREVIEW address, not a real on-chain mint)
}
async function collateralBase(canonicalId) {
  const rows = await dbQuery(`SELECT amount FROM collateral_ledger WHERE canonical_id=? AND direction='deposit' AND status='confirmed'`, [canonicalId])
  return rows.reduce((a, r) => a + toBaseUnits(r.amount), 0n)
}
async function redeemedBase(canonicalId) {
  // count released + in-flight (pending) redeems; EXCLUDE 'failed' (a reserved-then-aborted release
  // must not permanently reduce collateral). NULL status = legacy released rows → counted.
  const rows = await dbQuery(`SELECT amount FROM collateral_ledger WHERE canonical_id=? AND direction='redeem' AND (status IS NULL OR status != 'failed')`, [canonicalId])
  return rows.reduce((a, r) => a + toBaseUnits(r.amount), 0n)
}
// Is a broadcast BTC tx confirmed? true=confirmed, false=in mempool (unconfirmed), null=unknown/dropped.
async function btcTxConfirmed(txid) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(`https://mempool.space/api/tx/${txid}/status`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!r.ok) return null
    const s = await r.json()
    return !!s.confirmed
  } catch (_) { return null }
}
async function getAssetByTick(tick) {
  const clean = String(tick).replace(/^\$+/, '')
  const rows = await dbQuery('SELECT * FROM canonical_assets WHERE lower(exact_ticker)=lower(?) OR lower(exact_ticker)=lower(?)', [clean, '$' + clean])
  return rows[0] || null
}
// Resolve a registry asset, honoring an optional "proto:TICKER" qualifier so a collided ticker
// (e.g. ACME exists as both src-20 and acme) resolves to the intended protocol's row.
async function resolveAsset(raw) {
  const s = String(raw || '')
  const m = s.match(/^(acme|counterparty|xcp|src-?20)\s*:\s*(.+)$/i)
  if (!m) return getAssetByTick(s)
  const proto = m[1].toLowerCase().replace('xcp', 'counterparty').replace(/^src-?20$/, 'src-20')
  const t = m[2].trim().replace(/^\$+/, '')
  const rows = await dbQuery('SELECT * FROM canonical_assets WHERE (lower(exact_ticker)=lower(?) OR lower(exact_ticker)=lower(?)) AND source_protocol=? LIMIT 1', [t, '$' + t, proto])
  return rows[0] || null
}

// PREVIEW-ONLY hook: simulate a confirmed on-chain deposit so the mint lifecycle can be
// exercised end-to-end. Disabled entirely when PREVIEW is off (real collateral then comes
// ONLY from the relayer confirming real deposits).
app.post('/api/preview/confirm-deposit', async (req, res) => {
  if (!PREVIEW) return res.status(403).json({ error: 'preview hooks are disabled in live mode' })
  try {
    const { tick } = req.body || {}
    const amount = parseAmount((req.body || {}).amount)
    if (!amount) return res.status(400).json({ error: 'amount must be a positive number (≤18 dp)' })
    const asset = await getAssetByTick(tick || '')
    if (!asset) return res.status(404).json({ error: 'asset not in registry' })
    if (!asset.whitelisted) return res.status(403).json({ error: 'asset not whitelisted' })
    await dbExec(`INSERT INTO collateral_ledger (canonical_id, direction, amount, status, created_at)
      VALUES (?, 'deposit', ?, 'confirmed', ?)`, [asset.id, String(amount), now()])
    res.json({ simulated: true, tick: asset.exact_ticker, amount: String(amount),
      collateral: fromBaseUnits(await collateralBase(asset.id)), note: 'PREVIEW: simulated confirmed deposit (no real value).' })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Solana mint authority (interim single-key stand-in for the production multisig).
app.get('/api/mint/authority', async (_req, res) => {
  try { res.json(await solMint.authorityInfo()) }
  catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})
// One-time migration: hand existing raw-key-authority Solana mints to the Emblem vault.
app.post('/api/mint/migrate-authority', async (req, res) => {
  if (requireOperator(req, res)) return // protocol authority change — operator-only
  try {
    // 'emblem' (Solana raw→Emblem) | 'squads' (Solana Emblem→Squads) | 'safe' (EVM Emblem→Safe)
    const target = (req.body && req.body.target) || 'emblem'
    const chain = (req.body && req.body.chain) || 'base'
    if (target === 'safe') {
      if (!safe) return res.status(400).json({ error: 'safe multisig not available' })
      const safeAddr = await safe.ensureSafe(chain)
      if (!safeAddr) return res.status(500).json({ error: 'could not resolve the safe address' })
      const reps = await dbQuery(`SELECT dest_address FROM representations WHERE dest_chain=? AND dest_address IS NOT NULL`, [chain])
      const results = []
      for (const r of reps) {
        try { results.push({ contract: r.dest_address, ...(await evmMint.transferOwnershipTo(chain, r.dest_address, safeAddr)) }) }
        catch (e) { results.push({ contract: r.dest_address, error: String(e.message || e) }) }
      }
      return res.json({ target, chain, safe: safeAddr, migrated: results })
    }
    let squadsVault = null
    if (target === 'squads') {
      if (!squads) return res.status(400).json({ error: 'squads multisig not available' })
      await squads.ensureMultisig(); squadsVault = squads.vaultAddress()
      if (!squadsVault) return res.status(500).json({ error: 'could not resolve the squads vault address' })
    }
    const reps = await dbQuery(`SELECT dest_address FROM representations WHERE dest_chain='solana' AND dest_address IS NOT NULL`)
    const results = []
    for (const r of reps) {
      try {
        const out = target === 'squads' ? await solMint.setMintAuthority(r.dest_address, squadsVault) : await solMint.migrateAuthority(r.dest_address)
        results.push({ mint: r.dest_address, ...out })
      } catch (e) { results.push({ mint: r.dest_address, error: String(e.message || e) }) }
    }
    res.json({ target, squads_vault: squadsVault, migrated: results })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// EVM deployer/authority for Base + Ethereum (same address on both; fund per chain).
app.get('/api/mint/evm-authority', async (req, res) => {
  try {
    const chain = String(req.query.chain || 'base')
    if (!evmMint.isSupported(chain)) return res.status(400).json({ error: 'unsupported chain' })
    res.json(await evmMint.authorityInfo(chain))
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Deposit-gated mint core — enforces the solvency invariant, mints on-chain, records.
// Returns { status, body }. Shared by /api/mint and the AMM pool seeder.
async function performMint(tick, amount, receive_address, chain = 'solana', assetIn = null, opKey = null) {
  amount = parseAmount(amount)
  if (!amount) return { status: 400, body: { error: 'amount must be a positive number (≤18 dp)' } }
  if (!receive_address) return { status: 400, body: { error: 'a receive address is required' } }
  if (!(chain in DEST_DECIMALS)) return { status: 400, body: { error: 'unsupported destination chain' } }
  const asset = assetIn || await getAssetByTick(tick || '')
  if (!asset) return { status: 404, body: { error: 'asset not in registry' } }
  if (!asset.whitelisted) return { status: 403, body: { error: 'asset not whitelisted' } }

  // serialize per asset — the collateral check + mint + ledger write must be atomic vs
  // other mints of the same asset (they share one collateral pool across all chains). opKey (audit)
  // makes the on-chain mint crash-safe/idempotent for callers that pass one.
  return withAssetLock(asset.id, () => mintCritical(asset, amount, receive_address, chain, opKey))
}
async function mintCritical(asset, amount, receive_address, chain, opKey = null) {
  // Effective on-chain decimals: EVM = 18; Solana sized so max_supply fits u64 (≤9, e.g. BOSHI→7).
  // Round the mint DOWN to THIS precision so DB accounting == on-chain supply exactly (no drift),
  // and so the representation can never exceed its backing.
  const destDec = chain === 'solana' ? solanaDecimalsFor(asset.max_supply) : DEST_DECIMALS[chain]
  const mintAmt = floorToDecimals(amount, destDec) // round DOWN to real dest precision
  const mintBase = toBaseUnits(mintAmt)
  if (mintBase <= 0n) return { status: 400, body: { error: `amount below ${chain} precision (${destDec} dp)` } }

  const availableCollateral = (await collateralBase(asset.id)) - (await redeemedBase(asset.id))
  const rep = (await dbQuery('SELECT * FROM representations WHERE canonical_id=? AND dest_chain=?', [asset.id, chain]))[0]
  const circulating = rep ? toBaseUnits(rep.circulating_supply || '0') : 0n
  const allReps = await dbQuery('SELECT circulating_supply FROM representations WHERE canonical_id=?', [asset.id])
  const totalCirculating = allReps.reduce((a, r) => a + toBaseUnits(r.circulating_supply || '0'), 0n)
  const maxSupply = toBaseUnits(asset.max_supply || '0')

  // ---- R05 durable op guard (F07) — A03 (audit): the op MUST be consulted BEFORE the solvency check.
  // Otherwise a RESUME of a mint another worker already completed would fail the (now headroom-consumed)
  // collateral check and be misread by the caller as a definite failure → it would delete backing that
  // is now backing the peer's mint = insolvency. Reserve first; a completed op returns the cached result
  // without re-checking collateral; a reserved/uncertain op reconciles; a legacy-format op fails closed.
  if (opKey) {
    // A02: absence of the EXACT key must not be read as "no prior mint" — older builds keyed the op with a
    // trailing :chain:recipient. Detect any legacy-format op for this identity and fail closed (reconcile).
    const legacy = await dbQuery(`SELECT state FROM operations WHERE op_key LIKE ? LIMIT 1`, [opKey + ':%'])
    if (legacy.length) return { status: 409, body: { error: 'a legacy operation record exists for this mint identity — reconciliation required (not auto-retried)', reconcile: true, op: opKey } }
    const g = await opReserve(opKey, { action: 'mint', canonical_id: asset.id, amount: mintAmt, chain, recipient: receive_address })
    if (!g.fresh) {
      if (g.row && g.row.state === 'completed') return { status: 200, body: { ...JSON.parse(g.row.result_json || '{}'), idempotent: true } }
      return { status: 409, body: { error: 'a prior attempt for this mint did not complete — reconciliation required (not auto-retried)', reconcile: true, op: opKey } }
    }
  }

  // ---- SOLVENCY INVARIANT (cross-chain): total circulating ≤ collateral ≤ source supply ----
  // A fresh reservation now exists (if opKey); a definite pre-send rejection here must RELEASE it so a
  // legitimate later retry (e.g. after more collateral is confirmed) is not permanently blocked.
  if (totalCirculating + mintBase > availableCollateral) {
    if (opKey) await opFail(opKey)
    return { status: 409, body: { error: 'insufficient collateral', reason: 'mint would exceed confirmed backing across all chains',
      total_circulating: fromBaseUnits(totalCirculating), minting: mintAmt, collateral: fromBaseUnits(availableCollateral) } }
  }
  if (maxSupply > 0n && totalCirculating + mintBase > maxSupply) {
    if (opKey) await opFail(opKey)
    return { status: 409, body: { error: 'exceeds source max supply', max_supply: asset.max_supply } }
  }

  // ---- execute on-chain FIRST, then record ----
  let mintAddr, signature, explorer = null, real = false
  if (chain === 'solana') {
    try {
      const amountBase = toBaseUnits(mintAmt, destDec) // same rounding as accounting → no drift
      if (amountBase > U64_MAX) return { status: 400, body: { error: 'amount exceeds Solana SPL u64 capacity even at 0 decimals' } }
      // Authority: Emblem managed signer (default) OR the Squads M-of-N multisig (propose→approve→execute).
      const useSquads = solanaAuthorityMode() === 'squads' && squads
      const r = useSquads
        ? await squads.mintViaMultisig({ existingMint: rep && rep.dest_address, amountBase, decimals: destDec, recipient: receive_address })
        : await solMint.mintTokens({ existingMint: rep && rep.dest_address, amountBase, decimals: destDec, recipient: receive_address })
      mintAddr = r.mint; signature = r.signature; explorer = r.explorer; real = true
    } catch (e) {
      // UNFUNDED = nothing was signed/sent (pre-send) → retryable; anything else is uncertain → reconcile.
      if (opKey) await (e.code === 'UNFUNDED' ? opFail(opKey) : opReconcile(opKey))
      if (e.code === 'UNFUNDED') return { status: 503, body: { error: e.message, needs_funding: e.authority, chain } }
      return { status: 502, body: { error: 'solana mint failed (outcome uncertain — reconcile before retry): ' + String(e.message || e), reconcile: true } }
    }
  } else if (evmMint.isSupported(chain)) {
    try {
      const disp = displayTicker(asset.exact_ticker)
      const symbol = /^[!-~]+$/.test(disp) ? disp.replace(/[^A-Za-z0-9$_-]/g, '').slice(0, 11) || ('SRC' + asset.id) : ('SRC' + asset.id)
      const srcOrigin = labels.srcOriginFor(asset) // protocol-correct provenance (src-20 / counterparty / acme)
      const useSafe = evmAuthorityMode() === 'safe' && safe
      if (useSafe) {
        // Authority = Safe M-of-N. Ensure a Safe-owned rep exists, then mint via the Safe (owners sign).
        let contract = rep && rep.dest_address
        if (!contract) contract = await safe.deployRep({ chain, name: `Stampy ${disp}`, symbol, srcOrigin })
        const r = await safe.mintViaSafe({ chain, rep: contract, amountToken: mintAmt, recipient: receive_address })
        mintAddr = contract; signature = r.txHash; explorer = r.explorer; real = true
      } else {
        const r = await evmMint.deployAndMint({ chain, existingContract: rep && rep.dest_address,
          name: `Stampy ${disp}`, symbol, srcOrigin, amountToken: mintAmt, recipient: receive_address })
        mintAddr = r.contract; signature = r.txHash; explorer = r.explorer; real = true
      }
    } catch (e) {
      // UNFUNDED/BADADDR = pre-send (nothing minted) → retryable; anything else is uncertain → reconcile.
      if (opKey) await ((e.code === 'UNFUNDED' || e.code === 'BADADDR') ? opFail(opKey) : opReconcile(opKey))
      if (e.code === 'UNFUNDED') return { status: 503, body: { error: e.message, needs_funding: e.authority, chain } }
      if (e.code === 'BADADDR') return { status: 400, body: { error: e.message } }
      return { status: 502, body: { error: `${chain} mint failed (outcome uncertain — reconcile before retry): ` + String(e.message || e), reconcile: true } }
    }
  } else return { status: 400, body: { error: 'unsupported destination chain' } }

  const newCirc = circulating + mintBase
  if (rep) await dbExec('UPDATE representations SET circulating_supply=?, status=?, dest_address=?, updated_at=? WHERE id=?',
    [fromBaseUnits(newCirc, 18), 'CANONICAL', mintAddr, now(), rep.id])
  else await dbExec(`INSERT INTO representations (canonical_id, dest_chain, dest_address, dest_symbol, status, authority_model, circulating_supply, updated_at)
    VALUES (?, ?, ?, ?, 'CANONICAL', 'interim single-key (audited multisig in prod)', ?, ?)`,
    [asset.id, chain, mintAddr, displayTicker(asset.exact_ticker), fromBaseUnits(newCirc, 18), now()])
  await dbExec(`INSERT INTO collateral_ledger (canonical_id, direction, amount, dest_chain, dest_tx, status, created_at)
    VALUES (?, 'mint', ?, ?, ?, ?, ?)`, [asset.id, mintAmt, chain, signature, real ? 'minted' : 'simulated', now()])

  // op COMPLETED only AFTER the accounting is written (audit): so a retry that finds 'completed'
  // truly has consistent accounting. A crash/throw before here leaves the op 'reserved' → a retry
  // reconciles (never re-mints) and surfaces the incomplete accounting rather than hiding it.
  if (opKey) await opComplete(opKey, signature, { minted: true, real, chain, tick: asset.exact_ticker, amount_minted: mintAmt, mint_address: mintAddr, receive_address, signature, explorer })

  return { status: 200, body: { minted: true, real, chain, network: chain === 'solana' ? 'devnet' : 'testnet',
    tick: asset.exact_ticker, amount_requested: String(amount), amount_minted: mintAmt, rounded: mintAmt !== String(amount),
    dest_decimals: destDec, mint_address: mintAddr, receive_address, signature, explorer,
    circulating: fromBaseUnits(newCirc), total_circulating: fromBaseUnits(totalCirculating + mintBase),
    collateral: fromBaseUnits(availableCollateral),
    note: real ? (chain === 'solana' ? 'Real SPL token minted on Solana devnet; solvency-checked.' : `Real ERC-20 minted on ${chain} testnet; solvency-checked.`) : 'accounting real; on-chain step unavailable.' } }
}
app.post('/api/mint', async (req, res) => {
  // Direct mint = minting a rep against the protocol's collateral to an ARBITRARY recipient. That
  // would be free backed tokens for anyone → operator-only. Legit public minting is verify-deposit
  // (bound to the depositor) or cross-chain move (burn-verified).
  if (requireOperator(req, res)) return
  try {
    const { tick, amount, receive_address, chain, op_key } = req.body || {}
    // A06/F07 (audit): a value-changing mint MUST carry a durable idempotency key. Without one, a mint
    // that lands on-chain but whose accounting write fails can be duplicated on retry (two mint effects,
    // one accounted). Reject omission rather than silently passing null (which bypassed the op guard).
    if (!op_key || typeof op_key !== 'string') return res.status(400).json({ error: 'op_key required — supply a stable idempotency key so a retried mint cannot double-issue' })
    const r = await performMint(tick, amount, receive_address, chain, null, op_key)
    res.status(r.status).json(r.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// CROSS-CHAIN MOVE — burn a representation on one chain, mint it on another. Same collateral
// backs both, so total circulating is unchanged and the solvency invariant is preserved.
// The user first burns their rep on the source chain and passes the burn txid; we verify it,
// decrement the source (reflecting the real on-chain burn), and mint on the destination.
// Per-chain burn FINALITY policy (audit R06) — a burn must be this deep before it can authorize a
// real Bitcoin release; a shallow burn could be reorged out after the asset is gone. Env-overridable.
const BURN_FINALITY = { base: 3, ethereum: 12, 'base-mainnet': parseInt(process.env.BASE_MAINNET_BURN_CONFIRMATIONS || '20', 10) }
async function verifyRepBurn(chain, txid, repAddress, amount) {
  let r, wantBase
  if (chain === 'solana') {
    wantBase = BigInt(toBaseUnits(floorToDecimals(amount, DEST_DECIMALS.solana), DEST_DECIMALS.solana))
    r = await solMint.verifyBurn(txid, repAddress, wantBase.toString())
  } else if (chain in DEST_DECIMALS) {
    const tok = floorToDecimals(amount, DEST_DECIMALS[chain])
    wantBase = BigInt(_ethers.parseUnits(String(tok), 18).toString()) // the evm verifier compares at 18dp
    r = await evmMint.verifyBurn(chain, txid, repAddress, tok)
  } else return { valid: false, reason: 'unsupported source chain' }
  if (!r || !r.valid) return r || { valid: false, reason: 'burn verification failed' }
  // R04/F10 (audit): EXACT-amount entitlement. The on-chain burn must EQUAL the requested amount, not
  // merely be ≥ it — otherwise a partial redeem/move consumes the whole (larger) one-shot burn and
  // strands the remainder. Burn EXACTLY what you redeem/move.
  if (r.burned != null && BigInt(r.burned) !== wantBase)
    return { valid: false, reason: `on-chain burn is ${r.burned} base units, but you requested ${wantBase} — burn EXACTLY the amount you redeem/move`, exact: false, burned: String(r.burned) }
  // Solana finality is enforced in the verifier (queried at 'finalized'); EVM needs depth.
  if (chain !== 'solana') {
    const min = BURN_FINALITY[chain] != null ? BURN_FINALITY[chain] : 12
    if ((r.confirmations || 0) < min) return { valid: false, reason: `burn not final yet — ${r.confirmations || 0}/${min} confirmations required`, confirmations: r.confirmations || 0, final: false }
  }
  return r
}
// ---- PR3 (audit): shared consume-once burn registry + owner→recipient authorization ----
// Normalize a burn txid: EVM hashes are hex (case-insensitive) → lowercase; Solana sigs are
// base58 (CASE-SENSITIVE) → leave untouched. Prevents case-variant replay on EVM.
function normTxid(chain, txid) { const t = String(txid || '').trim(); return chain === 'solana' ? t : t.toLowerCase() }
async function burnConsumed(chain, txid) { return (await dbQuery('SELECT * FROM consumed_burns WHERE burn_txid=?', [normTxid(chain, txid)]))[0] || null }
// Atomic claim: the PRIMARY KEY makes the INSERT fail if this burn was already consumed by ANY
// endpoint (redeem OR move) — so a single burn can never authorize two releases/mints.
async function consumeBurn({ chain, txid, canonical_id, purpose, owner, amount }) {
  try { await dbExec('INSERT INTO consumed_burns (burn_txid, chain, canonical_id, purpose, owner, amount, created_at) VALUES (?,?,?,?,?,?,?)', [normTxid(chain, txid), chain, canonical_id, purpose, owner || null, String(amount), now()]); return { ok: true } }
  catch (_) { return { ok: false } } // UNIQUE violation = already consumed
}
// Verify the BURNER authorized this exact action (binds owner → destination). msg = a binding
// string; sig = signature by the burn owner. EVM owner → EIP-191; Solana owner → ed25519.
function verifyBurnOwnerSig(chain, owner, msg, sig) {
  if (!owner || !sig) return false
  try {
    if (chain === 'solana') return nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(String(sig)), bs58.decode(String(owner)))
    return _ethers.verifyMessage(msg, String(sig)).toLowerCase() === String(owner).toLowerCase()
  } catch (_) { return false }
}
function moveBindingMsg({ burn_txid, to_chain, to_address, amount }) { return `StampySwap move: burn ${burn_txid} → mint ${amount} on ${to_chain} to ${to_address}` }
function redeemBindingMsg({ burn_txid, to, amount }) { return `StampySwap redeem: burn ${burn_txid} → release ${amount} to ${to}` }

// ---- Durable operation records (audit R05 / F06-F07) — make on-chain effects crash-safe. An op is
// RESERVED (unique op_key) before the external effect, COMPLETED with its txid after, or marked for
// reconciliation on an uncertain outcome. A retry of the same op_key resumes idempotently and NEVER
// re-executes a completed/uncertain effect. Uses the DB PRIMARY KEY for cross-process atomicity. ----
async function opReserve(op_key, meta) {
  try {
    await dbExec(`INSERT INTO operations (op_key, action, canonical_id, amount, chain, recipient, state, created_at, updated_at) VALUES (?,?,?,?,?,?,'reserved',?,?)`,
      [op_key, meta.action, meta.canonical_id, String(meta.amount), meta.chain, meta.recipient || null, now(), now()])
    return { fresh: true }
  } catch (_) { return { fresh: false, row: (await dbQuery('SELECT * FROM operations WHERE op_key=?', [op_key]))[0] || null } }
}
async function opComplete(op_key, tx_id, result) {
  // audit: do NOT silently swallow a persistence failure. If this UPDATE fails the op stays 'reserved'
  // → a retry reconciles (never re-mints), but we must surface it loudly for reconciliation.
  try { await dbExec(`UPDATE operations SET state='completed', tx_id=?, result_json=?, updated_at=? WHERE op_key=?`, [tx_id || null, JSON.stringify(result || {}), now(), op_key]) }
  catch (e) { console.error(`opComplete PERSIST FAILED for ${op_key} (tx ${tx_id}) — on-chain effect done, op stuck 'reserved', RECONCILE: ${e.message || e}`) }
}
async function opFail(op_key) { await dbExec('DELETE FROM operations WHERE op_key=?', [op_key]).catch(() => {}) } // proven pre-send failure → retryable
async function opReconcile(op_key) { await dbExec(`UPDATE operations SET state='reconcile', updated_at=? WHERE op_key=?`, [now(), op_key]).catch(() => {}) }

// A01 (audit): EXACTLY-ONCE release finalization, shared by normal redemption AND operator reconcile.
// The circulation decrement and the terminal-status write are separate rows (no cross-row transaction),
// so a crash between them could let a retry decrement circulation TWICE → understated circulation →
// over-mint headroom → insolvency. Fix: make the TERMINAL STATUS TRANSITION the compare-and-set gate.
// Only the caller that flips the reserved row (pending|reconcile → released, changes===1) performs the
// decrement; any repeat finds it already released (changes 0) and does nothing. Ordering is fail-CLOSED:
// if the process dies after the flip but before the decrement, circulation stays too HIGH (never
// over-mints) and the terminal row won't be decremented again. dbExec returns {changes} (Dashboard API).
async function finalizeReleaseOnce({ ledgerId, canonicalId, chain, amountBase, releaseTxid }) {
  const upd = await dbExec(`UPDATE collateral_ledger SET status='released', btc_txid=COALESCE(?, btc_txid) WHERE id=? AND status IN ('pending','reconcile')`, [releaseTxid || null, ledgerId])
  if (!upd || (upd.changes || 0) < 1) return { alreadyFinalized: true } // a prior finalize already claimed the decrement
  const rep = (await dbQuery('SELECT id, circulating_supply FROM representations WHERE canonical_id=? AND dest_chain=?', [canonicalId, chain]))[0]
  if (rep) {
    const circ = toBaseUnits(rep.circulating_supply || '0')
    const newCirc = circ >= amountBase ? circ - amountBase : 0n
    await dbExec('UPDATE representations SET circulating_supply=?, updated_at=? WHERE id=?', [fromBaseUnits(newCirc, 18), now(), rep.id])
  }
  return { finalized: true }
}
app.post('/api/move', async (req, res) => {
  // F05 (audit): a move mints dest tokens against a source burn. Without binding the burn to the
  // receiver, a caller could front-run someone's public burn and claim the minted output. So a
  // NON-operator must prove they are the burner by signing the move binding (burn_txid → to_chain/
  // to_address/amount) with the key that burned. Operator header remains a back-office bypass.
  const operatorMode = isOperator(req)
  try {
    const { tick, from_chain, to_chain, burn_txid, to_address, auth_sig } = req.body || {}
    const amount = parseAmount((req.body || {}).amount)
    if (!amount) return res.status(400).json({ error: 'amount must be a positive number' })
    if (!burn_txid || !to_address) return res.status(400).json({ error: 'burn_txid and to_address required' })
    if (!(from_chain in DEST_DECIMALS) || !(to_chain in DEST_DECIMALS)) return res.status(400).json({ error: 'unsupported chain' })
    if (from_chain === to_chain) return res.status(400).json({ error: 'source and destination chains must differ' })
    const asset = await getAssetByTick(tick || '')
    if (!asset) return res.status(404).json({ error: 'asset not in registry' })
    if (!asset.whitelisted) return res.status(403).json({ error: 'asset not whitelisted' })
    const fromRep = (await dbQuery('SELECT * FROM representations WHERE canonical_id=? AND dest_chain=?', [asset.id, from_chain]))[0]
    if (!fromRep || !fromRep.dest_address) return res.status(404).json({ error: `no ${from_chain} representation for this asset` })
    // verify the real on-chain burn (read-only — safe to run before the lock). Returns the burner.
    const burn = await verifyRepBurn(from_chain, burn_txid, fromRep.dest_address, amount)
    if (!burn.valid) return res.status(409).json({ error: 'burn not verified', reason: burn.reason })
    // F05 BIND: the BURNER must authorize THIS move to THIS destination — else anyone could claim
    // another holder's burn to their own address. Signed by the burn owner (EVM EIP-191 / Solana ed25519).
    if (!operatorMode) {
      const bmsg = moveBindingMsg({ burn_txid, to_chain, to_address, amount })
      if (!verifyBurnOwnerSig(from_chain, burn.owner, bmsg, auth_sig))
        return res.status(401).json({ error: 'authorization required — sign the move binding with the key that burned the source tokens', binding_message: bmsg, burn_owner: burn.owner })
    }

    const out = await withAssetLock(asset.id, async () => {
      // F06 (audit) — a move is: [1] verified on-chain burn (done, external) → [2] source decrement (DB)
      // → [3] destination mint (external). A crash between 2 and 3 must be RESUMABLE without either
      // re-decrementing the source or re-consuming the burn. The consumed_burns row is the durable
      // marker of "step 2 done"; the dest-mint op (keyed on the BURN identity, NOT the target address,
      // so one burn can never mint to two addresses) is the marker of "step 3 done".
      const moveKey = recovery.moveOpKey(normTxid(from_chain, burn_txid))
      const existing = await burnConsumed(from_chain, burn_txid)
      const mv = recovery.resolveMoveBurn(existing, asset.id)
      if (mv.action === 'reject')
        return { status: 409, body: { error: 'burn already consumed by a redeem or another action' } }
      // The move-out ledger row carries an explicit PHASE: 'pending' (decrement NOT yet confirmed) →
      // 'decremented' (source debit committed). A05 (audit): the mere existence of the consumed-burn
      // marker does NOT prove the source was debited — so we gate the destination mint on the move-out
      // row being 'decremented', never on the burn marker alone. This makes over-issuance impossible.
      const moveOut = (await dbQuery(`SELECT * FROM collateral_ledger WHERE direction='move-out' AND btc_txid=? AND canonical_id=?`, [burn_txid, asset.id]))[0]
      if (mv.action === 'resume') {
        // burn was claimed by a prior attempt. Only proceed to the dest mint if the source debit is
        // CONFIRMED ('decremented'). Otherwise the debit outcome is unknown → fail-closed reconcile
        // (never re-debit, never mint against an un-reduced source).
        if (!moveOut || moveOut.status !== 'decremented')
          return { status: 409, body: { error: 'move source-debit state is uncertain — awaiting reconciliation (not auto-retried)', reconcile: true } }
      } else {
        // mv.action === 'start' — FIRST attempt: claim burn → record move-out 'pending' → debit source →
        // mark 'decremented'. Debit BEFORE the 'decremented' mark so a crash between leaves the row
        // 'pending' → a later resume reconciles instead of blindly re-debiting or over-issuing.
        const claim = await consumeBurn({ chain: from_chain, txid: burn_txid, canonical_id: asset.id, purpose: 'move', owner: burn.owner, amount })
        if (!claim.ok) return { status: 409, body: { error: 'burn already consumed (race)' } }
        const fresh = (await dbQuery('SELECT circulating_supply FROM representations WHERE id=?', [fromRep.id]))[0]
        const circ = toBaseUnits((fresh && fresh.circulating_supply) || '0')
        if (toBaseUnits(amount) > circ) {
          // the move never started → free the burn so it stays retryable (nothing was decremented yet)
          await dbExec('DELETE FROM consumed_burns WHERE burn_txid=?', [normTxid(from_chain, burn_txid)]).catch(() => {})
          return { status: 409, body: { error: 'move exceeds source circulating', circulating: fromBaseUnits(circ) } }
        }
        await dbExec(`INSERT OR IGNORE INTO collateral_ledger (canonical_id, direction, amount, dest_chain, btc_txid, status, created_at) VALUES (?, 'move-out', ?, ?, ?, 'pending', ?)`, [asset.id, amount, from_chain, burn_txid, now()])
        await dbExec('UPDATE representations SET circulating_supply=?, updated_at=? WHERE id=?', [fromBaseUnits(circ - toBaseUnits(amount), 18), now(), fromRep.id])
        // CAS mark: only flips 'pending'→'decremented' (a re-run after the debit can't double-debit)
        await dbExec(`UPDATE collateral_ledger SET status='decremented' WHERE direction='move-out' AND btc_txid=? AND canonical_id=? AND status='pending'`, [burn_txid, asset.id])
      }
      // mint on destination (unlocked core; total circulating now back to original → solvent)
      const m = await mintCritical(asset, amount, to_address, to_chain, moveKey)
      if (m.status !== 200) {
        // The source is CORRECTLY decremented (the burn really happened on-chain) — we do NOT roll that
        // back. The retryable unit is JUST the destination mint: resubmit the SAME burn_txid and the
        // RESUME path above re-drives step 3. Uncertain outcome → reconcile (no auto-retry).
        const uncertain = !!(m.body && m.body.reconcile)
        return { status: m.status, body: {
          error: 'source burned' + (uncertain ? ' — destination mint outcome UNCERTAIN, flagged for reconciliation' : ' — destination mint failed; resubmit the SAME burn_txid to complete the move') + ': ' + (m.body.error || ''),
          reconcile: uncertain, resumable: !uncertain, source_decremented: true } }
      }
      return { status: 200, body: { moved: true, tick: asset.exact_ticker, amount, from: from_chain, to: to_chain, burn_txid, destination: m.body } }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Redemption — burn representation, release collateral. Enforces circulating ≥ amount.
app.post('/api/redeem', async (req, res) => {
  try {
    const { tick, chain = 'solana' } = req.body || {}
    const amount = parseAmount((req.body || {}).amount)
    if (!amount) return res.status(400).json({ error: 'amount must be a positive number (≤18 dp)' })
    if (!(chain in DEST_DECIMALS)) return res.status(400).json({ error: 'unsupported chain' })
    const asset = await getAssetByTick(tick || '')
    if (!asset) return res.status(404).json({ error: 'asset not in registry' })
    // P0-2 (audit 2345961): this legacy endpoint only decrements SQL circulating with NO on-chain
    // burn and NO vault release — it lies to proof-of-reserves and desyncs the solvency oracle.
    // Real redemptions go through POST /api/custody/redeem (burn-proof). Preview/operator only.
    if (!PREVIEW && !isOperator(req)) return res.status(403).json({ error: 'legacy accounting-only redeem is disabled — use POST /api/custody/redeem (on-chain burn proof required). Operator/preview override only.' })
    const out = await withAssetLock(asset.id, async () => {
      const burnBase = toBaseUnits(amount)
      const rep = (await dbQuery('SELECT * FROM representations WHERE canonical_id=? AND dest_chain=?', [asset.id, chain]))[0]
      const circulating = rep ? toBaseUnits(rep.circulating_supply || '0') : 0n
      if (burnBase > circulating) return { status: 409, body: { error: 'cannot redeem more than circulating', circulating: fromBaseUnits(circulating) } }
      const newCirc = circulating - burnBase
      await dbExec('UPDATE representations SET circulating_supply=?, status=?, updated_at=? WHERE id=?',
        [fromBaseUnits(newCirc, 18), newCirc === 0n ? 'RETIRED' : 'CANONICAL', now(), rep.id])
      await dbExec(`INSERT INTO collateral_ledger (canonical_id, direction, amount, dest_chain, status, created_at)
        VALUES (?, 'redeem', ?, ?, 'released', ?)`, [asset.id, floorToDecimals(amount, DEST_DECIMALS[chain]), chain, now()])
      return { status: 200, body: { redeemed: true, tick: asset.exact_ticker, chain, amount: String(amount),
        circulating: fromBaseUnits(newCirc), note: 'Representation burned; equivalent collateral released.' } }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// REAL proof-of-reserves — per-asset collateral vs circulating, with the solvency check.
app.get('/api/reserves', async (_req, res) => {
  try {
    const reps = await dbQuery(`SELECT r.canonical_id, r.dest_chain, r.dest_address, r.status, r.circulating_supply, ca.exact_ticker
      FROM representations r JOIN canonical_assets ca ON ca.id=r.canonical_id WHERE r.status IN ('CANONICAL','VERIFIED')`)
    const byAsset = {}
    for (const r of reps) {
      if (!byAsset[r.canonical_id]) {
        const coll = await collateralBase(r.canonical_id), red = await redeemedBase(r.canonical_id)
        byAsset[r.canonical_id] = { tick: r.exact_ticker, display: displayTicker(r.exact_ticker),
          collateral_base: coll - red, circulating_base: 0n, chains: [] }
      }
      const a = byAsset[r.canonical_id]
      a.circulating_base += toBaseUnits(r.circulating_supply || '0')
      a.chains.push({ chain: r.dest_chain, address: r.dest_address, circulating: fromBaseUnits(toBaseUnits(r.circulating_supply || '0')) })
    }
    // indicative USD pricing (thin memecoin markets) — server-side, cached, honest
    const btc = await prices.btcUsd().catch(() => null)
    const protoOf = {}
    for (const r of reps) protoOf[r.canonical_id] = r  // any rep row carries the tick; protocol from canonical_assets
    const priced = {}
    await Promise.all(Object.values(byAsset).map(async a => {
      const ca = (await dbQuery('SELECT source_protocol FROM canonical_assets WHERE lower(exact_ticker)=lower(?)', [a.tick]))[0]
      priced[a.tick] = await prices.priceAsset({ tick: a.tick, protocol: ca && ca.source_protocol }, btc).catch(() => null)
    }))
    let tvlUsd = 0, tvlThinUsd = 0
    const assets = Object.values(byAsset).map(a => {
      const p = priced[a.tick] || {}
      const collateral = fromBaseUnits(a.collateral_base)
      const usdVal = (p.price_usd != null) ? Number(collateral) * p.price_usd : null
      const val = (usdVal != null && Number.isFinite(usdVal)) ? usdVal : null
      // Headline TVL counts only reliable (non-thin) markets; thin/scarce prices are shown but
      // tallied separately so a single-dispenser ask on an ultra-scarce asset can't distort it.
      if (val != null) { if (p.thin) tvlThinUsd += val; else tvlUsd += val }
      return {
        tick: a.tick, display: a.display,
        collateral, circulating: fromBaseUnits(a.circulating_base),
        solvent: a.circulating_base <= a.collateral_base,
        ratio: a.collateral_base > 0n ? Number((a.circulating_base * 10000n) / a.collateral_base) / 100 : 0,
        chains: a.chains,
        price_usd: p.price_usd ?? null, price_btc: p.price_btc ?? null, change_24h: p.change_24h ?? null,
        market_cap_usd: p.market_cap_usd ?? null, price_source: p.source || 'none',
        thin: !!p.thin, price_note: p.note ?? null, value_usd: val,
      }
    })
    res.json({ preview: PREVIEW, invariant: 'circulating ≤ collateral ≤ source_supply',
      all_solvent: assets.every(a => a.solvent), assets, btc_usd: btc,
      tvl_usd: tvlUsd, tvl_thin_usd: tvlThinUsd,
      note: PREVIEW ? 'PREVIEW — accounting is real and solvency-enforced; on-chain mints are simulated.' : 'live' })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Indicative USD/BTC prices for assets in the registry (or a ?ticks=A,B,C subset). Honest:
// SRC-20 from stampchain market, XCP from cheapest open dispenser — thin/meme markets.
app.get('/api/prices', async (req, res) => {
  try {
    const btc = await prices.btcUsd().catch(() => null)
    let rows
    if (req.query.ticks) {
      const ticks = String(req.query.ticks).split(',').map(s => s.trim()).filter(Boolean).slice(0, 40)
      rows = []
      for (const t of ticks) { const r = (await dbQuery('SELECT exact_ticker, source_protocol FROM canonical_assets WHERE lower(exact_ticker)=lower(?)', [t.replace(/^\$+/, '')]))[0]; if (r) rows.push(r) }
    } else {
      rows = await dbQuery('SELECT exact_ticker, source_protocol FROM canonical_assets WHERE whitelisted=1 LIMIT 40')
    }
    const out = {}
    await Promise.all(rows.map(async r => {
      const p = await prices.priceAsset({ tick: r.exact_ticker, protocol: r.source_protocol }, btc).catch(() => null)
      out[r.exact_ticker] = p ? { price_usd: p.price_usd ?? null, price_btc: p.price_btc ?? null, change_24h: p.change_24h ?? null, market_cap_usd: p.market_cap_usd ?? null, source: p.source } : { price_usd: null, source: 'none' }
    }))
    res.json({ btc_usd: btc, prices: out })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Custody status — the Emblem-managed vault BTC address + whether deposits are live.
app.get('/api/custody/status', async (_req, res) => {
  try {
    const s = await custody.status()
    // R07: don't claim deposits are live while the service is paused — reflect maintenance truthfully.
    if (MAINTENANCE) { s.deposits_live = false; s.service = 'maintenance'; s.note = 'Deposits/mints/redemptions are PAUSED for security remediation. Custody holds real assets; nothing new is accepted right now.' }
    res.json(s)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// READ-ONLY deposit DETECTION (ACME Phase 1). Proves the app SEES + ATTRIBUTES + CONFIRMS a
// deposit into the vault — nothing is credited, minted, or released. This is the safe surface for
// the gated tiny test. ?tick=ACME_ASSET [&source=BTC_ADDR] [&amount=WHOLE].
app.get('/api/custody/detect', async (req, res) => {
  try {
    if (!VAULT_ADDR) return res.status(503).json({ error: 'custody address not provisioned' })
    // Protocol may be forced via ?protocol=acme or a `acme:TICKER` prefix. This is what lets a
    // COLLIDED ticker (ACME/SOAP/SADIE also exist as SRC-20/XCP) reach the ACME adapter — the
    // bare registry lookup resolves collided names to SRC-20/XCP first (dispatch precedence).
    const rawTick = String(req.query.tick || '')
    let protocol = (req.query.protocol ? String(req.query.protocol) : '').toLowerCase()
    let tick = rawTick
    const pm = rawTick.match(/^(acme|counterparty|xcp|src-?20)\s*:\s*(.+)$/i)
    if (pm) { protocol = pm[1].toLowerCase(); tick = pm[2].trim() }
    if (!tick) return res.status(400).json({ error: 'tick required (optionally ?protocol=acme, or "acme:TICKER")' })

    const known = await getAssetByTick(tick)
    const isAcme = protocol === 'acme' || (!protocol && known && known.source_protocol === 'acme')
    if (isAcme) {
      if (!acme) return res.status(400).json({ error: 'ACME adapter unavailable' })
      // Prefer registry decimals when the asset is a known ACME row; otherwise resolve straight
      // from acme.pics so a collided/unregistered ticker still works for read-only detection.
      let exact = tick, dec = null
      if (known && known.source_protocol === 'acme') { exact = known.exact_ticker; dec = known.decimals == null ? null : Number(known.decimals) }
      if (dec == null) {
        const a = await acme.lookupAsset(tick).catch(() => null)
        if (!a) return res.status(404).json({ error: `ACME asset '${tick}' not found on acme.pics` })
        exact = a.exact_ticker || tick; dec = a.divisible ? 8 : 0
      }
      const source = req.query.source ? String(req.query.source) : null
      const minQtyBase = req.query.amount ? acme.toBase(parseAmount(req.query.amount) || '0', dec) : null
      const deposits = await acme.findDeposits(exact, VAULT_ADDR, { source, minQtyBase })
      // lifecycle: which deposits are already credited/minted? (ledger key = acme:<txid>)
      const minted = new Set()
      if (deposits.length) {
        const keys = deposits.map(d => `acme:${d.tx_hash}`)
        const rows = await dbQuery(`SELECT btc_txid FROM collateral_ledger WHERE direction='deposit' AND btc_txid IN (${keys.map(() => '?').join(',')})`, keys)
        for (const r of rows) minted.add(String(r.btc_txid))
      }
      const detailed = await Promise.all(deposits.map(async d => {
        const confs = await acme.confirmations(d.block_index).catch(() => 0)
        return { tx_hash: d.tx_hash, source: d.source, quantity: acme.fromBase(d.quantity_base, dec),
          block_index: d.block_index, confirmations: confs, confirmed: confs >= ACME_CONFIRMS,
          minted: minted.has(`acme:${d.tx_hash}`) }
      }))
      const vaultBalance = acme.fromBase(await acme.addressBalanceBase(VAULT_ADDR, exact).catch(() => '0'), dec)
      return res.json({ protocol: 'acme', asset: exact, decimals: dec, vault: VAULT_ADDR, vault_balance: vaultBalance,
        confirms_required: ACME_CONFIRMS, detected: detailed.length, deposits: detailed,
        registered: !!(known && known.source_protocol === 'acme'),
        note: 'READ-ONLY detection — nothing credited, minted, or released.' })
    }
    if (!known) return res.status(404).json({ error: 'asset not in registry — discover it first, or pass ?protocol=acme' })
    return res.status(400).json({ error: `detection not wired for source_protocol='${known.source_protocol}' (ACME only for now)` })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// READ-ONLY wrap ROUTE for external explorers (the ACME Terminal) — describes how an asset wraps
// through StampySwap: supported/whitelisted, the vault deposit address, target chains + any minted
// rep contract, current reserves, confirmations, fees, and step-by-step. NO side effects; the
// value-moving deposit→mint happens in the StampySwap app (wallet + BIP-322), never via this call.
const WRAP_CHAIN_META = {
  solana:   { chain_label: 'Solana Devnet',   is_testnet: true, explorer: 'https://explorer.solana.com/address/%s?cluster=devnet' },
  base:     { chain_label: 'Base Sepolia',     is_testnet: true, explorer: 'https://sepolia.basescan.org/token/%s' },
  ethereum: { chain_label: 'Ethereum Sepolia', is_testnet: true, explorer: 'https://sepolia.etherscan.io/token/%s' },
  'base-mainnet': { chain_label: 'Base', is_testnet: false, explorer: 'https://basescan.org/token/%s' },
}
app.get('/api/wrap/route', async (req, res) => {
  try {
    const rawTick = String(req.query.asset || req.query.tick || '')
    let protocol = (req.query.protocol ? String(req.query.protocol) : '').toLowerCase()
    let tick = rawTick
    const pm = rawTick.match(/^(acme|counterparty|xcp|src-?20)\s*:\s*(.+)$/i)
    if (pm) { protocol = pm[1].toLowerCase().replace('xcp', 'counterparty').replace(/^src-?20$/, 'src-20'); tick = pm[2].trim() }
    if (!tick) return res.status(400).json({ error: 'asset required (optionally ?protocol=acme or "acme:TICKER")' })

    let asset = null
    if (protocol === 'acme') {
      // Prefer the REGISTERED acme row (carries id + the whitelisted flag). The bare ticker can
      // collide with an SRC-20/Counterparty asset, so don't trust getAssetByTick's dispatch order.
      asset = (await dbQuery(`SELECT * FROM canonical_assets WHERE lower(exact_ticker)=lower(?) AND source_protocol='acme' LIMIT 1`, [tick]))[0] || null
      if (!asset && acme) { // not registered → resolve from acme.pics so the terminal can still plan it
        const a = await acme.lookupAsset(tick).catch(() => null)
        if (a) asset = { id: null, exact_ticker: a.exact_ticker || tick, source_protocol: 'acme', decimals: a.divisible ? 8 : 0, max_supply: a.max_supply, whitelisted: 0 }
      }
    } else {
      asset = await getAssetByTick(tick)
    }
    if (!asset) return res.json({ supported: false, asset: tick, reason: 'asset not recognized on any supported Bitcoin protocol (SRC-20 / Counterparty / ACME)' })

    const proto = asset.source_protocol
    const protoLabel = proto === 'src-20' ? 'Bitcoin SRC-20' : proto === 'counterparty' ? 'Counterparty' : proto === 'acme' ? 'ACME' : String(proto)
    const wl = !!asset.whitelisted

    const repRows = asset.id != null
      ? await dbQuery(`SELECT dest_chain, dest_address, circulating_supply FROM representations WHERE canonical_id=? AND status IN ('CANONICAL','VERIFIED')`, [asset.id])
      : []
    const repByChain = {}; for (const r of repRows) repByChain[r.dest_chain] = r
    const target_chains = Object.keys(DEST_DECIMALS).map(chain => {
      const meta = WRAP_CHAIN_META[chain] || {}, rep = repByChain[chain]
      return {
        chain, chain_label: meta.chain_label || chain, is_testnet: !!meta.is_testnet,
        decimals: chain === 'solana' ? solanaDecimalsFor(asset.max_supply) : DEST_DECIMALS[chain],
        rep_contract: rep ? rep.dest_address : null,
        rep_symbol: rep ? displayTicker(asset.exact_ticker) : null,
        explorer_url: rep && meta.explorer ? meta.explorer.replace('%s', rep.dest_address) : null,
      }
    })

    let coll = 0n, circ = 0n
    if (asset.id != null) {
      coll = (await collateralBase(asset.id)) - (await redeemedBase(asset.id)); if (coll < 0n) coll = 0n
      for (const r of repRows) circ += toBaseUnits(r.circulating_supply || '0')
    }
    const reserves = { collateral: fromBaseUnits(coll), circulating: fromBaseUnits(circ), solvent: circ <= coll, as_of: new Date().toISOString() }

    const minConf = proto === 'acme' ? ACME_CONFIRMS : CONFIRMS
    const fees = proto === 'acme'
      ? { protocol_fee_sats: 888, est_miner_fee_sats: 700, note: 'estimate — ACME protocol fee is fixed at 888 sats; miner fee varies with mempool' }
      : { protocol_fee_sats: null, est_miner_fee_sats: 700, note: 'estimate — miner fee varies with mempool' }

    const steps = [
      { n: 1, title: 'Connect a Bitcoin wallet', detail: `Prove control of the address holding your ${protoLabel} ${displayTicker(asset.exact_ticker)} (BIP-322 signature).`, actor: 'user' },
      { n: 2, title: 'Deposit to the custody vault', detail: `Send the asset to the Emblem-managed vault ${VAULT_ADDR || '(provisioning…)'} on Bitcoin mainnet.`, actor: 'user' },
      { n: 3, title: 'Detect & confirm', detail: `StampySwap detects the deposit, attributes it to you, and waits for ${minConf} confirmation(s).`, actor: 'stampyswap' },
      { n: 4, title: 'Mint the fungible representation', detail: 'A 1:1-backed rep is minted to your receive address — solvency-enforced, Emblem-signed (no raw keys).', actor: 'stampyswap' },
      { n: 5, title: 'Trade or redeem', detail: 'Swap the rep on the AMM, or redeem it 1:1 back to the original Bitcoin asset anytime.', actor: 'user' },
    ]

    // live market(s) this asset trades in — for the terminal's "live market" line. Best-effort.
    let market = null
    if (asset.id != null) {
      const pls = await dbQuery('SELECT * FROM pools WHERE canonical_a=? OR canonical_b=?', [asset.id, asset.id])
      const pairs = []
      for (const p of pls) {
        try {
          const r = await amm.getReserves(p.chain, p.pair_address)
          const ra = parseFloat(r.r0), rb = parseFloat(r.r1)
          const thisIsA = p.canonical_a === asset.id
          const thisSym = thisIsA ? p.symbol_a : p.symbol_b, otherSym = thisIsA ? p.symbol_b : p.symbol_a
          const thisRes = thisIsA ? ra : rb, otherRes = thisIsA ? rb : ra
          pairs.push({ pair_label: `${p.symbol_a}/${p.symbol_b}`, pair_address: p.pair_address, chain: p.chain,
            price: thisRes > 0 ? { [`${otherSym}_per_${thisSym}`]: otherRes / thisRes } : null,
            reserves: { [p.symbol_a]: r.r0, [p.symbol_b]: r.r1 },
            explorer_url: `${amm.EXPLORER[p.chain]}/address/${p.pair_address}` })
        } catch (_) { /* skip a pool we can't read on-chain */ }
      }
      if (pairs.length) market = { pairs }
    }

    res.json({
      supported: true,
      protocol: proto, protocol_label: protoLabel,
      asset: asset.exact_ticker, display: displayTicker(asset.exact_ticker),
      decimals: asset.decimals == null ? 8 : Number(asset.decimals),
      whitelisted: wl, enabled: wl && !MAINTENANCE, // R07: don't advertise "enabled" while paused
      reason: MAINTENANCE ? 'wrapping paused — service in maintenance (security remediation)' : (wl ? null : 'recognized but not yet enabled for wrapping'),
      service: MAINTENANCE ? 'maintenance' : 'live',
      vault_address: VAULT_ADDR,
      min_confirmations: minConf,
      fees, target_chains, reserves, market,
      preview: !repByChain['base-mainnet'], // LIVE once a Base-mainnet rep exists for this asset
      network_note: repByChain['base-mainnet']
        ? 'LIVE on Base mainnet — representation tradeable on Uniswap V2. Bitcoin custody is mainnet. (Other testnet reps may also exist.)'
        : 'Representations + AMM are on testnet (Base Sepolia / Solana devnet). Bitcoin custody is mainnet.',
      steps,
      detect_url: `api/custody/detect?protocol=${encodeURIComponent(proto)}&tick=${encodeURIComponent(asset.exact_ticker)}`,
      app_url: `/pub/${GROUP}/stampyswap/`,
      note: 'READ-ONLY route — nothing is deposited, minted, or moved by this call.',
    })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// REAL deposit → mint. Requires a genuinely-confirmed SRC-20 TRANSFER txid to the vault
// address (can't be faked — verified against the chain). Records real collateral (idempotent
// by txid), then mints the representation. This is the real deposit-gated mint.
app.post('/api/custody/verify-deposit', async (req, res) => {
  try {
    const { tick, amount, txid, receive_address, chain = 'solana' } = req.body || {}
    if (!tick || !receive_address) return res.status(400).json({ error: 'tick, receive_address required' })
    const amt = parseAmount(amount); if (!amt) return res.status(400).json({ error: 'amount must be a positive number' })
    if (!VAULT_ADDR) return res.status(503).json({ error: 'custody address not provisioned' })
    const asset = await resolveAsset(tick) // P1 (audit): honor "acme:TICKER" so collided names (ACME/SOAP) resolve to the right protocol
    if (!asset) return res.status(404).json({ error: 'asset not in registry' })
    if (!asset.whitelisted) return res.status(403).json({ error: 'asset not whitelisted' })
    // F09 (audit): the credited/minted amount must not carry MORE precision than the SOURCE asset
    // supports. Otherwise the deposit-match check (which truncates to source decimals) passes for a
    // small deposit while the larger fractional request is credited (e.g. 1 indivisible ACME → 1.9).
    const srcDec = asset.decimals == null ? 8 : Number(asset.decimals)
    if (toBaseUnits(floorToDecimals(amt, srcDec)) !== toBaseUnits(amt))
      return res.status(400).json({ error: `amount has more precision than ${displayTicker(asset.exact_ticker)} supports (${srcDec} decimals) — reduce precision` })
    // F08 (audit): only consume a claim for a chain we can actually MINT on. base-mainnet is
    // advertised in wrap routes but not yet wired into the mint path → fail CLOSED here rather than
    // recording a confirmed deposit that mintCritical would then reject ('unsupported destination').
    if (!(chain === 'solana' || evmMint.isSupported(chain)))
      return res.status(400).json({ error: `destination chain '${chain}' is not a supported mint target yet — deposit not consumed` })
    // AUTHENTICATION — bind the mint to whoever controls the on-chain deposit SOURCE. Without this,
    // anyone who observes a deposit (or front-runs it) could claim the mint to their own address.
    // Operator override (x-operator-token) exists only for back-office credits in the current phase.
    const _opTok = operatorToken()
    const operatorMode = !!(_opTok && req.headers['x-operator-token'] === _opTok)
    let boundSource = null
    if (!operatorMode) {
      const { source_address, binding_sig } = req.body || {}
      const bmsg = depositBindingMessage({ source: source_address || '<your BTC source address>', receive: receive_address, tick: asset.exact_ticker, amount: amt })
      if (!source_address || !binding_sig) return res.status(401).json({ error: 'deposit binding required — sign the binding message with the Bitcoin address that made the deposit (BIP-322) and pass source_address + binding_sig', binding_message: bmsg })
      let sigOk = false
      try { sigOk = Bip322Verifier.verifySignature(String(source_address), bmsg, String(binding_sig)) } catch (_) {}
      if (!sigOk) return res.status(401).json({ error: 'binding signature invalid — sign the EXACT binding message with the deposit source address', binding_message: bmsg })
      boundSource = String(source_address)
    }
    // SERIALIZE per asset: the deposit-verify → availBase/idempotency check → credit → mint must
    // be atomic. Two concurrent deposits of the same asset could otherwise both pass the check and
    // both credit+mint → double-credit → insolvency. We hold the lock and call mintCritical (the
    // UNLOCKED core) so we don't deadlock on the non-reentrant per-asset lock.
    const out = await withAssetLock(asset.id, async () => {
      let confirmations = CONFIRMS, ledgerKey = txid ? String(txid) : null
      if (asset.source_protocol === 'counterparty') {
        // FREEZE (P1 audit 2345961): XCP credit is a vault-balance DELTA, not per-tx attribution —
        // a past sender of this asset could claim leftover uncredited vault balance. Operator-only
        // until rewritten to true per-tx attribution.
        if (!operatorMode) return { status: 403, body: { error: 'XCP deposit→mint is temporarily operator-only pending per-tx attribution (audit) — contact the operator to credit a Counterparty deposit' } }
        // Counterparty "enhanced sends" encode the destination in OP_RETURN data (no BTC output
        // to the vault, no per-deposit txid), and balances are confirmed-only. So we credit only
        // the DELTA between the vault's confirmed balance and what we've already credited (net of
        // redemptions) — repeated calls can never double-credit past the real balance.
        const dec = asset.decimals == null ? 8 : Number(asset.decimals) // 0 (indivisible) is valid — don't `|| 8` it away
        // GUARD: while a redemption is still unconfirmed the vault's confirmed balance is stale-high
        // (the redeem hasn't left yet) — crediting now could mint against collateral on its way out.
        const recentRedeems = await dbQuery(`SELECT btc_txid FROM collateral_ledger WHERE canonical_id=? AND direction='redeem' AND btc_txid IS NOT NULL ORDER BY id DESC LIMIT 10`, [asset.id])
        for (const rr of recentRedeems) {
          if ((await btcTxConfirmed(rr.btc_txid)) === false) return { status: 409, body: { error: 'a redemption is in flight for this asset; retry once it confirms (vault balance is settling)', redeem_txid: rr.btc_txid } }
        }
        const balWhole = counterparty.fromBase(await counterparty.addressBalanceBase(VAULT_ADDR, asset.exact_ticker), dec)
        const balBase = toBaseUnits(balWhole)
        const netCredited = (await collateralBase(asset.id)) - (await redeemedBase(asset.id))
        const availBase = balBase - netCredited
        if (availBase <= 0n) return { status: 409, body: { error: 'no un-credited balance in the vault for this asset (already fully credited)', vault_balance: balWhole } }
        if (toBaseUnits(amt) > availBase) return { status: 409, body: { error: `amount exceeds un-credited vault balance (${fromBaseUnits(availBase)} available)`, vault_balance: balWhole, available: fromBaseUnits(availBase) } }
        // the caller must be a real depositor of this asset to the vault (best-effort attribution —
        // XCP balance-delta can't yet split multiple senders of the same asset; tx-level is a TODO).
        if (boundSource) {
          const sent = await counterparty.sentToVault(asset.exact_ticker, boundSource, VAULT_ADDR).catch(() => false)
          if (!sent) return { status: 403, body: { error: `no confirmed ${displayTicker(asset.exact_ticker)} send to the vault from ${boundSource} — only a depositor can claim the mint` } }
        }
        ledgerKey = `xcp:${asset.exact_ticker}:${fromBaseUnits(netCredited + toBaseUnits(amt))}`
      } else if (asset.source_protocol === 'acme') {
        // ACME (acme.pics) — balance-per-address like XCP, BUT with per-tx attribution (/sends
        // returns tx_hash/source/quantity/block). So we verify the SPECIFIC send by txid (cleaner
        // than XCP's balance-delta): tx-level match → source-binding → N-conf finality → txid
        // idempotency. Detection only; ACME redemption (envelope→PSBT construction) is a later phase.
        if (!acme) return { status: 400, body: { error: 'ACME adapter unavailable' } }
        if (!txid) return { status: 400, body: { error: 'txid (ACME send tx_hash) required for ACME deposits' } }
        const dec = asset.decimals == null ? 8 : Number(asset.decimals)
        const deposits = await acme.findDeposits(asset.exact_ticker, VAULT_ADDR, { source: boundSource || null, minQtyBase: acme.toBase(amt, dec) }).catch(() => [])
        const dep = deposits.find(d => String(d.tx_hash) === String(txid))
        if (!dep) return { status: 404, body: { error: 'no matching confirmed ACME send to the vault (by txid + source + amount≥)' } }
        if (boundSource && String(dep.source) !== boundSource) return { status: 403, body: { error: `this ACME deposit was sent by ${dep.source}, not the address you signed with (${boundSource})` } }
        const confs = await acme.confirmations(dep.block_index).catch(() => 0)
        if (confs < ACME_CONFIRMS) return { status: 409, body: { error: `awaiting confirmations (${confs}/${ACME_CONFIRMS})`, confirmations: confs } }
        confirmations = confs
        ledgerKey = `acme:${txid}` // per-tx idempotency (unique index prevents double-credit)
      } else {
        if (!txid) return { status: 400, body: { error: 'txid required for SRC-20 deposits' } }
        const check = await verifyDepositTxid(txid, asset.exact_ticker, amt, VAULT_ADDR)
        if (!check.found) return { status: 404, body: { error: 'deposit txid not found on-chain', check } }
        if (!check.valid) return { status: 409, body: { error: 'deposit does not match (op/tick/destination/amount)', reason: check.reason, check } }
        if (!check.confirmed) return { status: 409, body: { error: `awaiting confirmations (${check.confirmations}/${CONFIRMS})`, check } }
        // the deposit must have been made BY the address the caller proved control of
        if (boundSource && String(check.source) !== boundSource) return { status: 403, body: { error: `this deposit was made by ${check.source}, not the address you signed with (${boundSource}) — only the depositor can claim the mint` } }
        confirmations = check.confirmations
      }
      // ---- F06 (audit): idempotency keyed on the durable OP, not just the credit row ----
      // The credit (collateral_ledger) and the mint (op) are two writes; a crash between them must be
      // RESUMABLE, not permanently blocked. The op — deterministic per DEPOSIT identity (ledgerKey),
      // deliberately NOT per-recipient, so one credit can never mint to two addresses — is the source
      // of truth for "did this deposit's mint finish".
      const opKey = recovery.depositOpKey(ledgerKey)
      // A02: match the exact identity key OR any legacy-format key (older builds appended :chain:recipient).
      // Prefer a 'completed' record so a finished mint is always resolved as done, never re-driven.
      const priorOp = (await dbQuery(`SELECT * FROM operations WHERE op_key = ? OR op_key LIKE ? ORDER BY CASE state WHEN 'completed' THEN 0 ELSE 1 END LIMIT 1`, [opKey, opKey + ':%']))[0]
      const decision = recovery.resolveDepositOp(priorOp, receive_address)
      if (decision.action === 'done') // truly done → idempotent
        return { status: 409, body: { error: 'deposit already credited and minted', minted: JSON.parse((priorOp && priorOp.result_json) || '{}') } }
      if (decision.action === 'retarget') // in-flight, claimed for a different address → deposit spoken for
        return { status: 409, body: { error: `deposit already claimed for ${priorOp.chain}/${priorOp.recipient} — cannot re-target`, reconcile: true, op: opKey } }
      if (decision.action === 'reconcile') // reserved/reconcile → outcome unknown, never auto-retry
        return { status: 409, body: { error: 'a prior mint for this deposit did not complete — awaiting reconciliation (not auto-retried)', reconcile: true, op: opKey } }
      // decision.action === 'proceed'
      // No op yet → either the first attempt, or a crash AFTER the credit but BEFORE the mint reserved
      // (nothing was minted). Both are safe to (re)drive: ensure the credit exists (unique index makes a
      // re-insert a harmless no-op), then mint. The BIP-322 binding already proved the depositor chose
      // THIS receive_address, so resuming to it is authorized.
      const priorCredit = (await dbQuery('SELECT id FROM collateral_ledger WHERE btc_txid=?', [ledgerKey]))[0]
      let creditId = priorCredit ? priorCredit.id : null
      if (!priorCredit) {
        const ins = await dbExec(`INSERT INTO collateral_ledger (canonical_id, direction, amount, btc_txid, vault_address, confirmations, status, created_at)
          VALUES (?, 'deposit', ?, ?, ?, ?, 'confirmed', ?)`, [asset.id, amt, ledgerKey, VAULT_ADDR, confirmations, now()])
        creditId = ins.lastInsertRowid
      }
      let m
      try { m = await mintCritical(asset, amt, receive_address, chain, opKey) } // op-guarded (F07): reserve→mint→complete
      catch (e) {
        // audit: an UNEXPECTED throw after the credit is an UNKNOWN outcome. KEEP the credit (never
        // revert a possibly-successful mint → no circulating>collateral) and flag for reconciliation.
        return { status: 502, body: { error: 'mint threw — deposit credit kept (backing preserved), outcome uncertain, flagged for reconciliation: ' + String(e.message || e), reconcile: true } }
      }
      if (m.status !== 200) {
        // F06: definite pre-send failure (no reconcile flag → opFail already freed the op) → revert the
        // credit so the deposit can be retried clean. UNCERTAIN (reconcile) → KEEP credit + op stays for
        // reconciliation. Only delete a credit WE inserted this call (never a pre-existing resume credit).
        const uncertain = !!(m.body && m.body.reconcile)
        // A03: NEVER delete a credit merely because THIS request inserted it — a peer worker may have
        // minted against it in the interim. Delete only on a definite pre-send failure AND when no
        // completed op exists for this deposit (re-checked here to catch a concurrent completion).
        let safeToDelete = !uncertain && !priorCredit && creditId != null
        if (safeToDelete) {
          const opNow = (await dbQuery(`SELECT state FROM operations WHERE op_key = ? OR op_key LIKE ?`, [opKey, opKey + ':%']))[0]
          if (opNow && opNow.state === 'completed') safeToDelete = false // a mint landed → the credit now backs it
        }
        if (safeToDelete) await dbExec('DELETE FROM collateral_ledger WHERE id=?', [creditId]).catch(() => {})
        return { status: m.status, body: { deposit_reverted: safeToDelete, reconcile: uncertain, mint: m.body } }
      }
      return { status: 200, body: { deposit: { key: ledgerKey, confirmations, protocol: asset.source_protocol }, mint: m.body } }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// REDEEM (release SRC-20 from the vault) — burn the representation, then release via the
// Emblem-managed vault signer. GATED (custody.CUSTODY_LIVE) — real-value action.
app.post('/api/custody/redeem', async (req, res) => {
  try {
    const { tick, amount, to, chain = 'solana' } = req.body || {}
    const amt = parseAmount(amount); if (!amt) return res.status(400).json({ error: 'amount must be a positive number' })
    if (!to) return res.status(400).json({ error: 'destination BTC address required' })
    const asset = await getAssetByTick(tick || '')
    if (!asset) return res.status(404).json({ error: 'asset not in registry' })
    if (!custody.isLive()) return res.status(403).json({ error: 'custody redemption is gated — audited go-ahead required', gated: true })
    const operatorMode = isOperator(req)
    // PROOF-OF-BURN + crash-safe release, serialized per asset (P0-1, audit 2345961). A PUBLIC caller
    // MUST prove they burned the representation on-chain — binding the vault release to a real burn.
    // Without it, anyone (with CUSTODY_LIVE on) could trigger releases up to `circulating` WITHOUT
    // holding tokens = vault drain. We reserve a PENDING ledger row (keyed by burn_txid) BEFORE
    // broadcasting, so a crash between broadcast and finalize can't double-release on retry.
    // The operator header is an audited back-office override (no burn required).
    const out = await withAssetLock(asset.id, async () => {
      const rep = (await dbQuery('SELECT * FROM representations WHERE canonical_id=? AND dest_chain=?', [asset.id, chain]))[0]
      const circ = rep ? toBaseUnits(rep.circulating_supply || '0') : 0n
      if (toBaseUnits(amt) > circ) return { status: 409, body: { error: 'cannot redeem more than circulating', circulating: fromBaseUnits(circ) } }
      const { burn_txid, auth_sig } = req.body || {}
      let burnInfo = null
      if (!operatorMode) {
        if (!burn_txid) return { status: 401, body: { error: 'burn_txid required — burn your representation on-chain (transfer it to the zero address), then pass the burn txid so the release is bound to a real burn' } }
        if (await burnConsumed(chain, burn_txid)) return { status: 409, body: { error: 'burn already consumed by a redeem or move' } }
        if (!rep || !rep.dest_address) return { status: 404, body: { error: `no ${chain} representation to burn against` } }
        burnInfo = await verifyRepBurn(chain, burn_txid, rep.dest_address, amt)
        if (!burnInfo.valid) return { status: 409, body: { error: 'representation burn not verified on-chain', reason: burnInfo.reason } }
        // PR3/F05 BIND: the BURNER must authorize THIS release to THIS BTC address — otherwise
        // anyone could redeem another holder's burn to their own address. Signed by the burn owner.
        const bmsg = redeemBindingMsg({ burn_txid, to, amount: amt })
        if (!verifyBurnOwnerSig(chain, burnInfo.owner, bmsg, auth_sig))
          return { status: 401, body: { error: 'authorization required — sign the redeem binding message with the key that burned the tokens', binding_message: bmsg, burn_owner: burnInfo.owner } }
        // reserve the burn in the SHARED registry (atomic) BEFORE the external release
        const claim = await consumeBurn({ chain, txid: burn_txid, canonical_id: asset.id, purpose: 'redeem', owner: burnInfo.owner, amount: amt })
        if (!claim.ok) return { status: 409, body: { error: 'burn already consumed' } }
      }
      // reserve a pending accounting row BEFORE the external release (crash-safety)
      const pend = await dbExec(`INSERT INTO collateral_ledger (canonical_id, direction, amount, dest_chain, burn_txid, status, created_at) VALUES (?, 'redeem', ?, ?, ?, 'pending', ?)`, [asset.id, amt, chain, burn_txid || null, now()])
      let release
      const redeemDec = asset.decimals == null ? 8 : Number(asset.decimals)
      const redeemArgs = { tick: asset.exact_ticker, amount: amt, toAddress: to, protocol: asset.source_protocol, dec: redeemDec }
      // pass authoritative base units so custody asserts the composed quantity for BOTH protocols (audit)
      if (asset.source_protocol === 'counterparty') redeemArgs.qtyBase = counterparty.toBase(amt, redeemDec)
      if (asset.source_protocol === 'acme' && acme) redeemArgs.qtyBase = acme.toBase(amt, redeemDec)
      // R05: serialize the actual vault broadcast through the GLOBAL BTC lock — all assets share the
      // vault's UTXO set, so concurrent releases must not race for the same UTXO (double-spend).
      try { release = await withBtcVaultLock(() => custody.redeem(redeemArgs)) }
      catch (e) {
        // R02 (audit): ONLY a proven pre-send failure is retryable. `GATED` means custody is off →
        // nothing was composed/signed/broadcast → safe to free the reservation. ANY OTHER throw is an
        // UNKNOWN outcome (the node may have accepted the tx before the connection dropped) → KEEP the
        // burn consumed and mark the row for reconciliation. Never free a reservation on uncertainty.
        if (e.code === 'GATED') {
          await dbExec(`UPDATE collateral_ledger SET status='failed' WHERE id=?`, [pend.lastInsertRowid]).catch(() => {})
          if (!operatorMode && burn_txid) await dbExec('DELETE FROM consumed_burns WHERE burn_txid=?', [normTxid(chain, burn_txid)]).catch(() => {})
          return { status: 403, body: { error: e.message, gated: true } }
        }
        await dbExec(`UPDATE collateral_ledger SET status='reconcile' WHERE id=?`, [pend.lastInsertRowid]).catch(() => {})
        return { status: 502, body: { error: 'release outcome UNCERTAIN — burn kept consumed, flagged for manual reconciliation (no automatic retry): ' + String(e.message || e), reconcile: true } }
      }
      // release landed → finalize EXACTLY ONCE (A01): the CAS terminal transition gates the decrement.
      await finalizeReleaseOnce({ ledgerId: pend.lastInsertRowid, canonicalId: asset.id, chain, amountBase: toBaseUnits(amt), releaseTxid: release.txid })
      return { status: 200, body: { redeemed: true, release, circulating: fromBaseUnits(circ - toBaseUnits(amt)) } }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ============================================================================
// OPERATOR RECONCILE TOOL (audit: "redeemedBase reconcile concern")
// ----------------------------------------------------------------------------
// redeemedBase() counts every redeem ledger row except status='failed' — so a redeem that
// broadcast with an UNCERTAIN outcome (status='reconcile') or a crashed-mid-flight reservation
// (status='pending') keeps that collateral subtracted from available backing FOREVER, which can
// permanently block further mints. That fail-closed behaviour is deliberate (never free a
// possibly-released reservation automatically), but it needs an operator escape hatch: after the
// operator verifies the on-chain outcome by hand, they resolve the row to a terminal state here.
// Operator-only; back-office. Reconciling mint OPS (operations table) is the R05 durable-recovery
// batch — this tool only lists them for visibility.
// ----------------------------------------------------------------------------
app.get('/api/reconcile', async (req, res) => {
  if (requireOperator(req, res)) return
  try {
    const redeems = await dbQuery(
      `SELECT cl.id, cl.canonical_id, ca.exact_ticker, cl.amount, cl.dest_chain, cl.burn_txid, cl.btc_txid, cl.status, cl.created_at
       FROM collateral_ledger cl LEFT JOIN canonical_assets ca ON ca.id=cl.canonical_id
       WHERE cl.direction='redeem' AND cl.status IN ('pending','reconcile') ORDER BY cl.id`)
    const ops = await dbQuery(
      `SELECT op_key, action, canonical_id, amount, chain, recipient, state, tx_id, updated_at
       FROM operations WHERE state IN ('reserved','reconcile') ORDER BY updated_at DESC`).catch(() => [])
    res.json({
      stuck_redeems: redeems,
      stuck_ops: ops,
      note: 'Resolve a redeem row via POST /api/reconcile {kind:"redeem", id, resolution:"released"|"failed", release_txid?}. '
          + 'Verify the on-chain outcome FIRST. released=BTC actually left the vault (finalizes: decrements circulating, keeps burn consumed). '
          + 'failed=nothing left the vault (restores collateral, frees the burn so the holder can retry). '
          + 'Mint-op (operations) reconciliation is handled by the durable-recovery batch, not here.',
    })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

app.post('/api/reconcile', async (req, res) => {
  if (requireOperator(req, res)) return
  try {
    const { kind, id, resolution, release_txid } = req.body || {}
    if (kind !== 'redeem') return res.status(400).json({ error: 'only kind:"redeem" is reconcilable here (mint-op recovery is the R05 batch)' })
    if (resolution !== 'released' && resolution !== 'failed') return res.status(400).json({ error: 'resolution must be "released" or "failed"' })
    const row = (await dbQuery(`SELECT * FROM collateral_ledger WHERE id=? AND direction='redeem'`, [id]))[0]
    if (!row) return res.status(404).json({ error: 'redeem ledger row not found' })
    if (row.status !== 'pending' && row.status !== 'reconcile')
      return res.status(409).json({ error: `row is already terminal (status=${row.status}); nothing to reconcile` })

    const out = await withAssetLock(row.canonical_id, async () => {
      // re-read under the lock (a concurrent redeem for the same asset may have just resolved it)
      const cur = (await dbQuery('SELECT * FROM collateral_ledger WHERE id=?', [id]))[0]
      if (!cur || (cur.status !== 'pending' && cur.status !== 'reconcile'))
        return { status: 409, body: { error: `row no longer reconcilable (status=${cur ? cur.status : 'gone'})` } }
      const chain = cur.dest_chain
      if (resolution === 'released') {
        // BTC left the vault → finalize through the SAME exactly-once finalizer as the success path
        // (A01): the CAS terminal transition gates the decrement, so reconciling twice (or racing the
        // success path) can never decrement circulation more than once.
        const r = await finalizeReleaseOnce({ ledgerId: id, canonicalId: cur.canonical_id, chain, amountBase: toBaseUnits(cur.amount), releaseTxid: release_txid })
        return { status: 200, body: { reconciled: true, id, resolution, finalized: !!r.finalized, already_finalized: !!r.alreadyFinalized } }
      } else {
        // resolution === 'failed': nothing left the vault → restore collateral (redeemedBase excludes
        // 'failed') and FREE the consumed burn so the holder can retry. A04.1 (audit): free the burn
        // FIRST and CONFIRM it is gone; only then mark the row terminal-failed. If the free fails, leave
        // the row reconcilable and report truthfully — never claim freed_burn while the burn is stuck,
        // which would strand the holder's entitlement behind a terminal row.
        let freed_burn = true
        if (cur.burn_txid) {
          await dbExec('DELETE FROM consumed_burns WHERE burn_txid=?', [normTxid(chain, cur.burn_txid)]).catch(() => {})
          freed_burn = !(await burnConsumed(chain, cur.burn_txid)) // confirm it is actually gone
          if (!freed_burn) return { status: 500, body: { error: 'could not free the consumed burn — row left reconcilable (not marked failed); retry', reconciled: false } }
        }
        await dbExec(`UPDATE collateral_ledger SET status='failed' WHERE id=?`, [id])
        return { status: 200, body: { reconciled: true, id, resolution, freed_burn } }
      }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ============================================================================
// STAMP BRIDGE — one-way SRC-20 → Counterparty-Stamp conversion (IRREVERSIBLE)
// ============================================================================
// A special, allow-listed feature: burn an SRC-20 asset FOREVER to receive its matching
// Counterparty "stamp" twin from the vault. Whole-unit (stamps are typically indivisible),
// supply-conserving (vault only releases what was burned), idempotent by burn txid. This is
// a permanent, non-refundable action — hence gated + heavily warned. Reuses the proven
// SRC-20 transfer verifier (destination = a provably-unspendable burn address) + the proven
// Counterparty release path (custody.redeem).
const wholeInt = s => /^\d{1,30}$/.test(String(s || '')) ? String(s) : null

app.get('/api/stampbridge/config', async (_req, res) => {
  try {
    const rows = await dbQuery('SELECT src20_tick, stamp_asset, stamp_protocol, ratio, burn_address, enabled, note FROM stamp_bridges ORDER BY id')
    const bridges = []
    for (const b of rows) {
      let vaultHas = null
      try { vaultHas = counterparty.fromBase(await counterparty.addressBalanceBase(VAULT_ADDR, b.stamp_asset), 0) } catch (_) {}
      bridges.push({ src20_tick: b.src20_tick, display: displayTicker(b.src20_tick), stamp_asset: b.stamp_asset,
        ratio: b.ratio, burn_address: b.burn_address, enabled: !!b.enabled, custody_live: custody.isLive(),
        stamp_in_vault: vaultHas, note: b.note })
    }
    res.json({ bridges, warning: 'Bridging is ONE-WAY and PERMANENT: the SRC-20 is burned forever and cannot be recovered.' })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Quote: what you'd receive + the exact burn instructions. Read-only, no state change.
app.post('/api/stampbridge/quote', express.json(), async (req, res) => {
  try {
    const { src20_tick, amount } = req.body || {}
    const b = (await dbQuery('SELECT * FROM stamp_bridges WHERE lower(src20_tick)=lower(?)', [String(src20_tick || '').replace(/^\$+/, '')]))[0]
    if (!b) return res.status(404).json({ error: 'no stamp bridge for that asset' })
    const amt = wholeInt(amount); if (!amt || BigInt(amt) <= 0n) return res.status(400).json({ error: 'amount must be a whole number (stamps are indivisible)' })
    const out = String(BigInt(amt) * BigInt(b.ratio))
    let vaultHas = '0'; try { vaultHas = counterparty.fromBase(await counterparty.addressBalanceBase(VAULT_ADDR, b.stamp_asset), 0) } catch (_) {}
    const sufficient = BigInt(vaultHas) >= BigInt(out)
    res.json({
      src20_tick: b.src20_tick, stamp_asset: b.stamp_asset, burn_amount: amt, receive_amount: out,
      burn_address: b.burn_address, enabled: !!b.enabled, custody_live: custody.isLive(), stamp_in_vault: vaultHas, sufficient,
      instructions: `Send an SRC-20 TRANSFER of ${amt} ${displayTicker(b.src20_tick)} to ${b.burn_address} (a provably-unspendable burn address), then submit the txid. This BURNS your ${displayTicker(b.src20_tick)} PERMANENTLY.`,
      warning: 'ONE-WAY & IRREVERSIBLE — the burned SRC-20 can never be recovered.',
    })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Execute: verify the burn on-chain (SRC-20 TRANSFER to the burn address), then release the
// matching stamp from the vault. Idempotent by burn txid. Gated (real value released).
app.post('/api/stampbridge/execute', express.json(), async (req, res) => {
  try {
    const { src20_tick, amount, burn_txid, user_address } = req.body || {}
    if (!burn_txid || !user_address) return res.status(400).json({ error: 'burn_txid and user_address required' })
    const b = (await dbQuery('SELECT * FROM stamp_bridges WHERE lower(src20_tick)=lower(?)', [String(src20_tick || '').replace(/^\$+/, '')]))[0]
    if (!b) return res.status(404).json({ error: 'no stamp bridge for that asset' })
    if (!b.enabled) return res.status(403).json({ error: 'this stamp bridge is not enabled yet', gated: true })
    if (!custody.isLive()) return res.status(403).json({ error: 'stamp release is gated (custody not live) — audited go-ahead required', gated: true })
    const amt = wholeInt(amount); if (!amt || BigInt(amt) <= 0n) return res.status(400).json({ error: 'amount must be a whole number' })
    // SERIALIZE per bridge: dup-check → verify → release → record must be atomic, or two concurrent
    // calls for the same burn txid could both pass the check and both RELEASE the stamp (double-spend
    // the vault). The lock makes the second see the first's recorded op (dup) before it can release.
    const out = await withAssetLock(`stampbridge:${b.src20_tick}`, async () => {
      const dupRow = (await dbQuery('SELECT id, status, release_txid FROM bridge_ops WHERE burn_txid=?', [String(burn_txid)]))[0]
      if (dupRow) return { status: 409, body: { error: 'this burn txid was already bridged', op: dupRow } }
      // verify the burn: a confirmed SRC-20 TRANSFER of `amt` `tick` to the burn address (can't be faked)
      const check = await verifyDepositTxid(String(burn_txid), b.src20_tick, amt, b.burn_address)
      if (!check.found) return { status: 404, body: { error: 'burn txid not found in the SRC-20 index', check } }
      if (!check.valid) return { status: 409, body: { error: 'not a valid burn (must be a TRANSFER of the exact asset to the burn address)', reason: check.reason, check } }
      // R04/F10 (audit): EXACT entitlement — the on-chain burn to the burn address must EQUAL the claim
      // amount. verifyDepositTxid accepts on-chain ≥ requested (fine for deposits), but for the one-shot
      // irreversible bridge a partial claim would consume the victim's whole (larger) burn and strand the
      // rest. Require equality here so one burn bridges exactly its own amount.
      if (toBaseUnits(check.amt) !== toBaseUnits(amt))
        return { status: 409, body: { error: `the on-chain burn is ${check.amt} ${displayTicker(b.src20_tick)} but you are claiming ${amt} — bridge EXACTLY the amount you burned`, burn_amount: check.amt } }
      if (!check.confirmed) return { status: 409, body: { error: `awaiting confirmations (${check.confirmations}/${CONFIRMS})`, check } }
      // SECURITY: the burn address is PUBLIC — anyone could send the SRC-20 there, or front-run a
      // burn. So the stamp is released ONLY to the on-chain SOURCE that actually burned (check.source),
      // never to an arbitrary address. The submitted address must match the burner.
      if (!check.source) return { status: 409, body: { error: 'could not determine the burn source address' } }
      if (String(user_address) !== String(check.source))
        return { status: 403, body: { error: `the stamp is released only to the address that burned the ${displayTicker(b.src20_tick)} (${check.source}) — you cannot redirect it. Submit that address.`, burn_source: check.source } }
      // ANTI-REORG: an irreversible value release needs deeper burial than a normal deposit — a
      // reorg that un-burns the SRC-20 after we release the stamp would be a double-spend.
      if (check.confirmations < STAMP_BRIDGE_CONFIRMS)
        return { status: 409, body: { error: `burn needs ${STAMP_BRIDGE_CONFIRMS}+ confirmations for the irreversible bridge (has ${check.confirmations})`, check } }
      const rel = String(BigInt(amt) * BigInt(b.ratio))
      // defensive: confirm the vault actually holds enough of the stamp before releasing
      const held = BigInt(counterparty.toBase(counterparty.fromBase(await counterparty.addressBalanceBase(VAULT_ADDR, b.stamp_asset), 0), 0))
      if (held < BigInt(rel)) return { status: 409, body: { error: `vault holds ${held} ${b.stamp_asset}, cannot release ${rel}`, stamp_in_vault: held.toString() } }
      // A07 (audit): RESERVE the bridge op BEFORE broadcasting. The burn_txid UNIQUE constraint makes
      // this atomic — a concurrent or retried call cannot get past it, so an uncertain broadcast can
      // never be re-released. (The dup-check above already 409s any existing row; this closes the
      // crash-window between broadcast and record.)
      try {
        await dbExec(`INSERT INTO bridge_ops (src20_tick, stamp_asset, amount, burn_txid, user_address, status, created_at)
          VALUES (?,?,?,?,?,'reserving',?)`, [b.src20_tick, b.stamp_asset, rel, String(burn_txid), user_address, now()])
      } catch (_) {
        return { status: 409, body: { error: 'this burn is already being bridged — do not resubmit', burn_txid } }
      }
      let release
      try {
        // R05: shared-vault UTXO serialization — same global BTC lock as redeem.
        release = await withBtcVaultLock(() => custody.redeem({ tick: b.stamp_asset, amount: rel, toAddress: check.source, protocol: b.stamp_protocol, qtyBase: counterparty.toBase(rel, 0) }))
      } catch (e) {
        if (e.code === 'GATED') {
          // proven pre-send (nothing broadcast) → free the reservation so it stays retryable
          await dbExec(`DELETE FROM bridge_ops WHERE burn_txid=? AND status='reserving'`, [String(burn_txid)]).catch(() => {})
          return { status: 403, body: { error: e.message, gated: true } }
        }
        // UNKNOWN outcome → KEEP the reservation (never re-release), mark for reconciliation
        await dbExec(`UPDATE bridge_ops SET status='reconcile' WHERE burn_txid=?`, [String(burn_txid)]).catch(() => {})
        return { status: 502, body: { error: 'stamp release outcome UNCERTAIN — reserved, flagged for reconciliation (no auto-retry): ' + String(e.message || e), reconcile: true } }
      }
      await dbExec(`UPDATE bridge_ops SET status='released', release_txid=? WHERE burn_txid=?`, [release.txid, String(burn_txid)])
      return { status: 200, body: { bridged: true, burned: `${amt} ${displayTicker(b.src20_tick)}`, released: `${rel} ${b.stamp_asset}`, release, burn_txid } }
    })
    res.status(out.status).json(out.body)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Squads multisig status (Solana authority upgrade — built + proven on devnet, migration pending).
app.get('/api/multisig', async (_req, res) => {
  const out = { solana: { available: false }, evm: { available: false } }
  if (squads) { try { out.solana = { available: true, mode: solanaAuthorityMode(), active: solanaAuthorityMode() === 'squads', ...(await squads.info()) } } catch (_) {} }
  if (safe) { try { out.evm = { available: true, mode: evmAuthorityMode(), active: evmAuthorityMode() === 'safe', ...(await safe.info('base')) } } catch (_) {} }
  res.json(out)
})

// Trust & custody transparency — a peg MUST expose its trust model honestly (§21/§22).
// This reports exactly who controls custody + minting today, and the Emblem integration
// path to the production posture. No hand-waving: the real addresses are shown.
app.get('/api/trust', async (_req, res) => {
  try {
    let solAuth = null, evmAuth = null, sq = null
    try { solAuth = (await solMint.authorityInfo()) } catch (_) {}
    try { evmAuth = (await evmMint.authorityInfo('base')) } catch (_) {}
    const solMode = solanaAuthorityMode(), evmMode = evmAuthorityMode()
    let sf = null
    if (squads) { try { sq = await squads.info() } catch (_) {} }
    if (safe) { try { sf = await safe.info('base') } catch (_) {} }
    res.json({
      custody: await custody.status().catch(() => ({ provider: 'none' })),
      authorities: [
        { chain: 'solana', network: 'devnet',
          model: (solMode === 'squads' && sq) ? sq.model : ((solAuth && solAuth.authority_model) || 'unavailable'),
          address: (solMode === 'squads' && sq) ? sq.vault : (solAuth && solAuth.address), gas_payer: solAuth && solAuth.fee_payer,
          intended: 'Emblem managed signer → Squads multisig',
          multisig: sq ? { available: true, active: solMode === 'squads', model: sq.model, vault: sq.vault, threshold: sq.threshold, members: (sq.members || []).length } : { available: false } },
        { chain: 'base/ethereum', network: 'testnet',
          model: (evmMode === 'safe' && sf) ? sf.model : ((evmAuth && evmAuth.authority_model) || 'unavailable'),
          address: (evmMode === 'safe' && sf) ? sf.safe : (evmAuth && evmAuth.address), gas_payer: evmAuth && evmAuth.gas_deployer,
          intended: 'Emblem managed signer → Safe multisig',
          multisig: sf ? { available: true, active: evmMode === 'safe', model: sf.model, safe: sf.safe, threshold: sf.threshold, owners: (sf.owners || []).length } : { available: false } },
      ],
      invariant: 'circulating ≤ confirmed collateral ≤ source supply (enforced, cross-chain)',
      guarantees: ['deposit-gated minting', 'round-down decimals', 'per-asset solvency lock', 'txid-attributed + reorg-safe relayer', 'public proof-of-reserves'],
      roadmap_to_mainnet: ['security audit', 'Emblem Vault custody provisioning', 'multisig mint authority', 'on-chain proof-of-reserves', 'mainnet with real collateral'],
    })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ============================================================================
// Phase 7 — Native SRC-20 / SRC-20 AMM (real on-chain constant-product pair)
// ============================================================================
// §20: pool liquidity ≠ bridge collateral. Reserves are MINTED representations that an
// LP explicitly adds; each is still solvency-gated (counts in circulating). Custodied
// SRC-20 collateral never auto-becomes liquidity — someone chooses to mint + LP.
const EVM_CHAINS = ['base', 'ethereum']

// Create a native pool: mint both reps to the protocol LP, deploy the pair, seed liquidity.
// Deploy a mock EXTERNAL token (testnet demos only) — a stand-in for an existing on-chain
// token (an "ETH memecoin") that the LP holds but we do NOT mint as a backed representation.
app.post('/api/amm/deploy-mock', async (req, res) => {
  try {
    // Testing-only convenience (deploys a stand-in ERC-20 that spends real testnet gas). Gated
    // off in live mode + not exposed to spam — real external pools use a real token address.
    if (!PREVIEW) return res.status(403).json({ error: 'mock-token deploy is disabled in live mode — pass a real external token address to /api/amm/create instead' })
    const { symbol, name, supply, chain = 'base' } = req.body || {}
    if (!EVM_CHAINS.includes(chain)) return res.status(400).json({ error: 'EVM chain required' })
    if (!symbol || !parseAmount(supply)) return res.status(400).json({ error: 'symbol and positive supply required' })
    const addr = await amm.deployExternalToken(chain, name || symbol, String(symbol).slice(0, 11), parseAmount(supply))
    res.json({ token: addr, symbol, chain, explorer: `${amm.EXPLORER[chain]}/token/${addr}`, note: 'External token — NOT a backed representation; the LP holds it directly.' })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Create a pool. Side A is always one of our representations (minted, solvency-gated). Side B
// is EITHER another representation (tickB) OR an EXTERNAL token (external_b:{address,symbol,amount})
// that the LP already holds — enabling rep/memecoin pairs, not just rep/rep.
app.post('/api/amm/create', async (req, res) => {
  // Seeding a pool mints protocol-backed reps + deploys contracts (spends protocol gas). It's a
  // protocol liquidity decision, not a public action → operator-only.
  if (requireOperator(req, res)) return
  try {
    const { tickA, tickB, amountA, amountB, chain = 'base', external_b } = req.body || {}
    if (!EVM_CHAINS.includes(chain)) return res.status(400).json({ error: 'AMM currently on EVM testnet (base/ethereum)' })
    const a = await resolveAsset(tickA || '')
    if (!a) return res.status(404).json({ error: 'asset A must be in the registry' })
    const amtA = parseAmount(amountA); if (!amtA) return res.status(400).json({ error: 'amountA must be positive' })
    const lp = await amm.lpAddress(chain)

    // side A — mint the representation to the LP
    const mA = await performMint(a.exact_ticker, amtA, lp, chain, a, `pool-mint:${chain}:${a.exact_ticker}:${amtA}:${lp}`)
    if (mA.status !== 200) return res.status(mA.status).json({ stage: 'mint ' + a.exact_ticker, ...mA.body })
    const token0 = mA.body.mint_address, symA = displayTicker(a.exact_ticker), seedA = mA.body.amount_minted

    // side B — external token OR another representation
    let token1, symB, canonB, kindB, seedB
    if (external_b && external_b.address) {
      if (!ethersIsAddress(external_b.address)) return res.status(400).json({ error: 'external_b.address is not a valid EVM address' })
      const amt = parseAmount(external_b.amount); if (!amt) return res.status(400).json({ error: 'external_b.amount must be positive' })
      const bal = await amm.tokenBalance(chain, external_b.address, lp)
      if (parseFloat(bal) < parseFloat(amt)) return res.status(409).json({ error: `LP holds ${bal} of the external token, need ${amt}. Fund the LP (${lp}) with it first.` })
      token1 = external_b.address; symB = (external_b.symbol || 'EXT').slice(0, 11); canonB = 0; kindB = 'external'; seedB = amt
    } else {
      const b = await resolveAsset(tickB || '')
      if (!b) return res.status(404).json({ error: 'asset B must be in the registry (or provide external_b)' })
      if (a.id === b.id) return res.status(400).json({ error: 'cannot pair an asset with itself' })
      const amt = parseAmount(amountB); if (!amt) return res.status(400).json({ error: 'amountB must be positive' })
      const mB = await performMint(b.exact_ticker, amt, lp, chain, b, `pool-mint:${chain}:${b.exact_ticker}:${amt}:${lp}`)
      if (mB.status !== 200) return res.status(mB.status).json({ stage: 'mint ' + b.exact_ticker, ...mB.body })
      token1 = mB.body.mint_address; symB = displayTicker(b.exact_ticker); canonB = b.id; kindB = 'rep'; seedB = mB.body.amount_minted
    }
    const dup = await dbQuery('SELECT id FROM pools WHERE chain=? AND ((token_a=? AND token_b=?) OR (token_a=? AND token_b=?))', [chain, token0, token1, token1, token0])
    if (dup.length) return res.status(409).json({ error: 'pool already exists', pool_id: dup[0].id })

    const pair = await amm.deployPair(chain, token0, token1)
    const seed = await amm.addLiquidity(chain, pair, token0, token1, seedA, seedB)
    const ins = await dbExec(`INSERT INTO pools (chain, pair_address, canonical_a, canonical_b, token_a, token_b, symbol_a, symbol_b, kind_a, kind_b, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [chain, pair, a.id, canonB, token0, token1, symA, symB, 'rep', kindB, now()])
    const reserves = await amm.getReserves(chain, pair)
    res.json({ pool_id: ins.lastInsertRowid, chain, pair, pair_explorer: `${amm.EXPLORER[chain]}/address/${pair}`,
      pair_label: `${symA}/${symB}`, kind_b: kindB, token_a: token0, token_b: token1, seeded: seed,
      reserves: { [symA]: reserves.r0, [symB]: reserves.r1 } })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// List pools with live on-chain reserves + implied price.
app.get('/api/amm/pools', async (_req, res) => {
  try {
    const pools = await dbQuery('SELECT * FROM pools ORDER BY id DESC')
    const out = []
    for (const p of pools) {
      let reserves = null, price = null
      try {
        const r = await amm.getReserves(p.chain, p.pair_address)
        reserves = { a: r.r0, b: r.r1 }
        const ra = parseFloat(r.r0), rb = parseFloat(r.r1)
        price = ra > 0 ? { [`${p.symbol_b}_per_${p.symbol_a}`]: (rb / ra), [`${p.symbol_a}_per_${p.symbol_b}`]: (ra / rb) } : null
      } catch (_) {}
      out.push({ id: p.id, chain: p.chain, pair: p.pair_address, label: `${p.symbol_a}/${p.symbol_b}`,
        symbol_a: p.symbol_a, symbol_b: p.symbol_b, token_a: p.token_a, token_b: p.token_b,
        kind_a: p.kind_a || 'rep', kind_b: p.kind_b || 'rep',
        explorer: `${amm.EXPLORER[p.chain]}/address/${p.pair_address}`, reserves, price })
    }
    res.json({ pools: out })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Read-only swap quote (constant-product, 0.30% fee).
app.get('/api/amm/quote', async (req, res) => {
  try {
    const pool = (await dbQuery('SELECT * FROM pools WHERE id=?', [req.query.pool_id]))[0]
    if (!pool) return res.status(404).json({ error: 'pool not found' })
    const r = await amm.getReserves(pool.chain, pool.pair_address)
    const inIsA = String(req.query.token_in) === pool.token_a || String(req.query.token_in).toLowerCase() === String(pool.symbol_a).toLowerCase()
    const [rIn, rOut] = inIsA ? [r.r0, r.r1] : [r.r1, r.r0]
    const out = amm.quoteOut(rIn, rOut, req.query.amount_in || '0')
    res.json({ token_in: inIsA ? pool.symbol_a : pool.symbol_b, token_out: inIsA ? pool.symbol_b : pool.symbol_a,
      amount_in: String(req.query.amount_in || '0'), amount_out: out, reserves: { a: r.r0, b: r.r1 } })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Execute a swap (protocol-signed for demo; a real router lets users sign their own).
app.post('/api/amm/swap', async (req, res) => {
  // P0-3 (audit 2345961): this is a PROTOCOL-SIGNED demo swap that mints reps against unused
  // collateral for the caller — a gas drain + a way to shove pool price with protocol inventory.
  // Operator-only. Real users trade with their OWN wallet via the Uniswap deep-link in the UI.
  if (requireOperator(req, res)) return
  try {
    const { pool_id, token_in, amount_in, to } = req.body || {}
    const pool = (await dbQuery('SELECT * FROM pools WHERE id=?', [pool_id]))[0]
    if (!pool) return res.status(404).json({ error: 'pool not found' })
    const inIsA = String(token_in) === pool.token_a || String(token_in).toLowerCase() === String(pool.symbol_a).toLowerCase()
    const tokenInAddr = inIsA ? pool.token_a : pool.token_b
    const kindIn = inIsA ? (pool.kind_a || 'rep') : (pool.kind_b || 'rep')
    const vaultLp = await amm.lpAddress(pool.chain)
    // SECURITY: this is a PROTOCOL-SIGNED demo swap — the protocol FUNDS the input (mints the rep,
    // or spends its own external balance). So the output MUST stay in the protocol vault; if it
    // could go to an arbitrary `to`, anyone could mint-and-drain the pool's other side for free.
    // A real user swap (user provides the input token, signs, and receives the output) is the
    // production feature and will let the caller specify a recipient.
    const recipient = vaultLp
    // the swapper (Emblem vault) must hold token_in. Rep side: mint it to the vault (solvency-gated).
    // External side: NOT our token — the vault must already hold enough (we never mint it).
    let amtIn
    if (kindIn === 'external') {
      amtIn = parseAmount(amount_in); if (!amtIn) return res.status(400).json({ error: 'amount_in must be positive' })
      const bal = await amm.tokenBalance(pool.chain, tokenInAddr, vaultLp)
      if (parseFloat(bal) < parseFloat(amtIn)) return res.status(409).json({ error: `LP holds ${bal} of the external token, need ${amtIn}. External tokens are not minted by us — fund the LP (${vaultLp}) first.` })
    } else {
      const feedTick = inIsA ? pool.symbol_a : pool.symbol_b
      const asset = await getAssetByTick(feedTick)
      if (!asset) return res.status(404).json({ error: `input token ${feedTick} is not a registered representation` })
      const m = await performMint(asset.exact_ticker, amount_in, vaultLp, pool.chain)
      if (m.status !== 200) return res.status(m.status).json({ stage: 'fund swapper', ...m.body })
      amtIn = m.body.amount_minted
    }
    const r = await amm.swap(pool.chain, pool.pair_address, tokenInAddr, amtIn, recipient)
    const reserves = await amm.getReserves(pool.chain, pool.pair_address)
    res.json({ swapped: true, ...r, token_in: inIsA ? pool.symbol_a : pool.symbol_b, token_out: inIsA ? pool.symbol_b : pool.symbol_a,
      amount_in: amtIn, reserves: { [pool.symbol_a]: reserves.r0, [pool.symbol_b]: reserves.r1 } })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ============================================================================
// Phase 9 — Cross-chain routing over the liquidity graph (§24–27)
// ============================================================================
// Nodes = (canonical asset, chain) representations. Edges = AMM pools (swap, priced by
// live reserves) + cross-chain moves (same asset across chains, ~1:1). The router does a
// bounded best-path search to maximise output for a given input — e.g. "sell KEVIN on
// Solana, receive $BALD on Base" might route: move KEVIN sol→base, then swap on Base.
async function routeGraph() {
  const reps = await dbQuery(`SELECT r.canonical_id, r.dest_chain, r.dest_address, ca.exact_ticker
    FROM representations r JOIN canonical_assets ca ON ca.id=r.canonical_id WHERE r.status IN ('CANONICAL','VERIFIED')`)
  const nodes = new Map()
  for (const r of reps) nodes.set(`${r.canonical_id}:${r.dest_chain}`, { canonical_id: r.canonical_id, ticker: r.exact_ticker, chain: r.dest_chain })
  const adj = new Map()
  const addEdge = (from, e) => { if (!adj.has(from)) adj.set(from, []); adj.get(from).push(e) }
  const pools = await dbQuery('SELECT * FROM pools')
  for (const p of pools) {
    let res; try { res = await amm.getReserves(p.chain, p.pair_address) } catch (_) { continue }
    const na = `${p.canonical_a}:${p.chain}`, nb = `${p.canonical_b}:${p.chain}`
    if (nodes.has(na) && nodes.has(nb)) {
      addEdge(na, { to: nb, type: 'swap', chain: p.chain, rIn: res.r0, rOut: res.r1 })
      addEdge(nb, { to: na, type: 'swap', chain: p.chain, rIn: res.r1, rOut: res.r0 })
    }
  }
  const byAsset = {}
  for (const [, n] of nodes) (byAsset[n.canonical_id] ||= []).push(n)
  for (const list of Object.values(byAsset)) for (const a of list) for (const b of list) if (a.chain !== b.chain)
    addEdge(`${a.canonical_id}:${a.chain}`, { to: `${b.canonical_id}:${b.chain}`, type: 'move', chain_from: a.chain, chain_to: b.chain })
  return { nodes, adj }
}
function applyEdge(e, amountIn) {
  if (e.type === 'move') return String(amountIn)          // ~1:1 (same collateral)
  if (e.type === 'swap') return amm.quoteOut(e.rIn, e.rOut, amountIn) // constant-product, 0.30% fee
  return '0'
}
function bestRoute(graph, fromId, toId, amount, maxHops = 4) {
  let best = null
  const dfs = (nodeId, amt, path, visited) => {
    if (nodeId === toId && path.length) { const out = parseFloat(amt); if (!best || out > best.output) best = { output: out, path: [...path] }; return }
    if (path.length >= maxHops) return
    for (const e of (graph.adj.get(nodeId) || [])) {
      if (visited.has(e.to)) continue
      const outAmt = applyEdge(e, amt); if (parseFloat(outAmt) <= 0) continue
      visited.add(e.to); dfs(e.to, outAmt, [...path, { edge: e, from: nodeId, in: amt, out: outAmt }], visited); visited.delete(e.to)
    }
  }
  dfs(fromId, String(amount), [], new Set([fromId]))
  return best
}
async function resolveNodes(ticker, chain) {
  const asset = await getAssetByTick(ticker); if (!asset) return { asset: null, ids: [] }
  const reps = await dbQuery('SELECT dest_chain FROM representations WHERE canonical_id=?', [asset.id])
  return { asset, ids: reps.filter(r => !chain || r.dest_chain === chain).map(r => `${asset.id}:${r.dest_chain}`) }
}
app.get('/api/route', async (req, res) => {
  try {
    const amount = parseAmount(req.query.amount); if (!amount) return res.status(400).json({ error: 'amount must be a positive number' })
    const from = await resolveNodes(String(req.query.from || ''), req.query.from_chain)
    const to = await resolveNodes(String(req.query.to || ''), req.query.to_chain)
    if (!from.asset || !to.asset) return res.status(404).json({ error: 'from/to asset not in registry' })
    if (!from.ids.length) return res.status(404).json({ error: 'no representation for the source asset' + (req.query.from_chain ? ' on ' + req.query.from_chain : '') })
    if (!to.ids.length) return res.status(404).json({ error: 'no representation for the destination asset' + (req.query.to_chain ? ' on ' + req.query.to_chain : '') })
    const graph = await routeGraph()
    let best = null
    for (const f of from.ids) for (const t of to.ids) { if (f === t) continue; const r = bestRoute(graph, f, t, amount); if (r && (!best || r.output > best.output)) best = r }
    if (!best) return res.json({ found: false, note: 'no route — need a pool or a shared chain connecting these assets' })
    const steps = best.path.map(s => {
      const fn = graph.nodes.get(s.from), tn = graph.nodes.get(s.edge.to)
      return { type: s.edge.type,
        from: `${displayTicker(fn.ticker)} · ${fn.chain}`, to: `${displayTicker(tn.ticker)} · ${tn.chain}`,
        in: (+s.in).toLocaleString(undefined, { maximumFractionDigits: 6 }), out: (+s.out).toLocaleString(undefined, { maximumFractionDigits: 6 }) }
    })
    res.json({ found: true, from: displayTicker(from.asset.exact_ticker), to: displayTicker(to.asset.exact_ticker),
      amount_in: amount, amount_out: best.output, hops: steps.length, steps })
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// Arbitrage / mispricing detection (read-only analysis over the liquidity graph). Two signals:
//  (A) profitable CYCLES — a loop A→…→A that returns MORE than it started (after the 0.30% swap
//      fee per hop) is a risk-free arb.
//  (B) pool-vs-MARKET mispricing — a pool's implied price ratio vs the assets' indicative native
//      Bitcoin-market prices; a big divergence is an arb between the pool and the native market.
async function detectArbitrage() {
  const graph = await routeGraph()
  // (A) profitable cycles — bounded DFS from each node back to itself; dedupe by normalized ring.
  const seen = new Set(), cycles = []
  for (const [startId] of graph.nodes) {
    const dfs = (nodeId, amt, path, visited) => {
      for (const e of (graph.adj.get(nodeId) || [])) {
        const out = applyEdge(e, amt); if (parseFloat(out) <= 0) continue
        if (e.to === startId && path.length >= 1) {
          const profit = parseFloat(out) - 1 // started with 1 unit
          if (profit > 0.0005) {
            const ring = [...path.map(s => s.from), startId]
            const key = [...ring].sort().join('|') + ':' + ring.length
            if (!seen.has(key)) { seen.add(key); cycles.push({ hops: path.length + 1, profit_pct: +(profit * 100).toFixed(3),
              loop: ring.map(id => { const n = graph.nodes.get(id); return `${displayTicker(n.ticker)}·${n.chain}` }) }) }
          }
          continue
        }
        if (path.length >= 3 || visited.has(e.to)) continue
        visited.add(e.to); dfs(e.to, out, [...path, { from: nodeId }], visited); visited.delete(e.to)
      }
    }
    dfs(startId, '1', [], new Set([startId]))
  }
  // (B) pool vs native-market mispricing
  const btc = await prices.btcUsd().catch(() => null)
  const pools = await dbQuery('SELECT * FROM pools')
  const mispriced = []
  for (const p of pools) {
    if (p.kind_b === 'external') continue // external side has no native Bitcoin market to compare against
    let res; try { res = await amm.getReserves(p.chain, p.pair_address) } catch (_) { continue }
    const ra = parseFloat(res.r0), rb = parseFloat(res.r1); if (!(ra > 0 && rb > 0)) continue
    const a = (await dbQuery('SELECT exact_ticker, source_protocol FROM canonical_assets WHERE id=?', [p.canonical_a]))[0]
    const b = (await dbQuery('SELECT exact_ticker, source_protocol FROM canonical_assets WHERE id=?', [p.canonical_b]))[0]
    if (!a || !b) continue
    const pa = await prices.priceAsset({ tick: a.exact_ticker, protocol: a.source_protocol }, btc).catch(() => null)
    const pb = await prices.priceAsset({ tick: b.exact_ticker, protocol: b.source_protocol }, btc).catch(() => null)
    if (!(pa && pa.price_usd) || !(pb && pb.price_usd)) continue
    const poolRatio = rb / ra          // units of B per A, in the pool
    const marketRatio = pa.price_usd / pb.price_usd // units of B per A, by native market
    const divergence = (poolRatio / marketRatio - 1) * 100
    mispriced.push({ pool: p.id, pair: `${p.symbol_a}/${p.symbol_b}`, pool_ratio: poolRatio, market_ratio: marketRatio,
      divergence_pct: +divergence.toFixed(2), thin: !!(pa.thin || pb.thin),
      signal: Math.abs(divergence) > 2 ? `${divergence > 0 ? p.symbol_a : p.symbol_b} is cheaper in the pool than the native market` : 'fairly priced' })
  }
  return { cycles, pools: mispriced,
    note: 'Read-only. Cycles are fee-aware (0.30%/hop); pool mispricing compares the pool ratio to indicative native Bitcoin-market prices. ⚠ thin = one side has a thin/scarce market (signal is noisy).' }
}
app.get('/api/arbitrage', async (_req, res) => {
  try { res.json(await detectArbitrage()) } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// ---- Startup schema check + idempotent burn backfill (audit R03/C) ----
// The app CANNOT run DDL (Dashboard API blocks CREATE/ALTER) — the burn-registry schema is applied
// out-of-band. Here we VERIFY it exists (else SCHEMA_OK stays false → containment holds) and backfill
// historical burns so an old cross-chain move burn can't be redeemed again through the new registry.
// A08 (audit): schema readiness must verify the UNIQUENESS guarantees the idempotency logic depends on
// — not merely that columns exist. A same-column table WITHOUT the PRIMARY KEY on operations.op_key /
// consumed_burns.burn_txid would let two reservations of the same operation both "win" → double effect.
// Read-only inspection of the stored DDL + indexes; fail-closed if the guarantee is absent.
async function tableEnforcesUnique(table, col) {
  try {
    const t = await dbQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [table])
    const ddl = (t[0] && t[0].sql) || ''
    if (new RegExp('\\b' + col + '\\b[^,]*\\bPRIMARY KEY\\b', 'i').test(ddl)) return true            // inline PK
    if (new RegExp('\\bPRIMARY KEY\\s*\\([^)]*\\b' + col + '\\b', 'i').test(ddl)) return true          // table-level PK
    if (new RegExp('\\bUNIQUE\\s*\\([^)]*\\b' + col + '\\b', 'i').test(ddl)) return true                // inline UNIQUE(col)
    const idx = await dbQuery(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`, [table])
    return idx.some(r => /\bUNIQUE\b/i.test(r.sql || '') && new RegExp('\\b' + col + '\\b').test(r.sql || ''))
  } catch (_) { return false }
}
async function migrateSchema() {
  try {
    await dbQuery('SELECT burn_txid FROM consumed_burns LIMIT 1')
    await dbQuery('SELECT burn_txid FROM collateral_ledger LIMIT 1')
    await dbQuery('SELECT op_key FROM operations LIMIT 1') // R05 durable operation records
  } catch (e) {
    console.error('SCHEMA CHECK FAILED — burn registry missing; writes stay contained (SCHEMA_OK false). Apply migration (consumed_burns + operations + collateral_ledger.burn_txid). ' + (e.message || e))
    return // SCHEMA_OK stays false → containment holds even if STAMPY_MAINTENANCE=0
  }
  // A08: the idempotency PRIMARY KEYs MUST be present, or the whole crash-safety story is void.
  if (!(await tableEnforcesUnique('operations', 'op_key')) || !(await tableEnforcesUnique('consumed_burns', 'burn_txid'))) {
    console.error('SCHEMA CONSTRAINT CHECK FAILED — operations.op_key and consumed_burns.burn_txid must be UNIQUE/PRIMARY KEY. Writes stay contained (SCHEMA_OK false) until the constraints are in place.')
    return
  }
  try {
    // old moves recorded the rep-burn hash only in collateral_ledger.btc_txid (direction='move-out')
    await dbExec(`INSERT OR IGNORE INTO consumed_burns (burn_txid, chain, canonical_id, purpose, created_at)
      SELECT CASE WHEN dest_chain='solana' THEN btc_txid ELSE lower(btc_txid) END, dest_chain, canonical_id, 'move', created_at
      FROM collateral_ledger WHERE direction='move-out' AND btc_txid IS NOT NULL`)
    // prior redemptions that recorded a burn_txid (new-schema rows). A04 (audit): EXCLUDE 'failed'
    // rows — a failed redeem deliberately FREED its burn (GATED pre-send), so re-consuming it on
    // startup would permanently block the holder's legitimate retry. Only truly-consumed dispositions
    // (released / reconcile-uncertain) keep the burn reserved.
    await dbExec(`INSERT OR IGNORE INTO consumed_burns (burn_txid, chain, canonical_id, purpose, created_at)
      SELECT CASE WHEN dest_chain='solana' THEN burn_txid ELSE lower(burn_txid) END, dest_chain, canonical_id, 'redeem', created_at
      FROM collateral_ledger WHERE direction='redeem' AND burn_txid IS NOT NULL AND status != 'failed'`)
  } catch (e) {
    // audit R03: a FAILED backfill must NOT grant readiness — keep writes contained until it succeeds.
    console.error('SCHEMA BACKFILL FAILED — writes stay contained (SCHEMA_OK false) until migration completes: ' + (e.message || e))
    return
  }
  SCHEMA_OK = true // granted ONLY after schema verified AND historical backfill both succeed
  console.log('schema verified + burn backfill complete — SCHEMA_OK=true')
}
migrateSchema()
app.use(express.static(path.join(__dirname, 'public')))
app.listen(PORT, () => console.log(`StampySwap Phase 0-9 on ${PORT}`))
