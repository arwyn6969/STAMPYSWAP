'use strict'
// Canonicality & reorg CHECKER v5 — PURE detection-only (NOT a live watchdog). Fixes v3 defects:
// (1) base58 compared EXACTLY/case-sensitively (hex only is case-normalized); (2) base58 DECODED and
// required to be exactly 32/64 bytes + canonical; (3) NO JSON.stringify of untrusted input (bigint/
// cyclic can't crash) — malformed inputs PAUSE with fixed reasons; (4) ALL trusted same-chain
// observations checked for contradiction (order-independent) before per-group counting; (5) a
// qualified completeness-complete source that OMITS an expected effect is explicit disagreement;
// (6) bounded, versioned, plain-scalar policy at every level; (7) trusted anchor CONTENT lives in
// policy.expectedAnchors — labels alone don't pin content. Only policy throws; data pauses.
const LIMITS = { maxAnchors: 1024, maxSources: 1024, maxExpected: 256, maxChains: 64, maxProviders: 256, maxProviderChains: 64, maxEffectsPerSource: 256, maxFields: 32 }
// Strict bounded own-DATA schema (defends against inherited fields, accessor/throwing getters,
// unknown/oversized fields, and nested-map blowups). Returns a null-proto copy of ONLY the allowed
// own data fields, or throws RecErr. For POLICY this throws (outside the data catch); for OBSERVATIONS
// and ANCHORS the caller converts any throw to a FIXED pause reason.
class RecErr extends Error { constructor(code) { super(code); this.code = code } }
function strictRecord(v, allowed, where) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new RecErr(where + ':not_plain_object')
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) throw new RecErr(where + ':non_plain_prototype')
  const names = Object.getOwnPropertyNames(v)
  if (names.length > LIMITS.maxFields) throw new RecErr(where + ':too_many_fields')
  const out = Object.create(null)
  for (const k of names) {
    if (!allowed.has(k)) throw new RecErr(where + ':unknown_field')
    const d = Object.getOwnPropertyDescriptor(v, k)
    if (!d || typeof d.get === 'function' || typeof d.set === 'function' || !('value' in d)) throw new RecErr(where + ':accessor_field')
    out[k] = d.value
  }
  return out
}
const SOURCE_FIELDS = new Set(['providerId', 'chain', 'networkId', 'protocolVersion', 'historyComplete', 'paginationComplete', 'tipHeight', 'finalizedHeight', 'observedAt', 'effects', 'error'])
const EFFECT_FIELDS = new Set(['kind', 'chain', 'identity', 'assetId', 'height', 'blockHash', 'amountBase'])
const ANCHOR_FIELDS = new Set(['effect_id', 'kind', 'chain', 'identity', 'assetId', 'height', 'blockHash', 'amountBase'])
const CHAINCFG_FIELDS = new Set(['networkId', 'protocolVersion', 'idForm', 'hashForm', 'minConfirmations'])
const PROVIDER_FIELDS = new Set(['operatorGroup', 'chains'])
const POLICY_FIELDS = new Set(['version', 'minIndependentSources', 'now', 'maxObsAgeMs', 'chains', 'trustedProviders', 'expectedAnchors'])
function sanitizeSource(s, P) {
  const o = strictRecord(s, SOURCE_FIELDS, 'source')
  if (o.effects !== undefined) {
    if (o.effects === null || typeof o.effects !== 'object' || Array.isArray(o.effects) || (Object.getPrototypeOf(o.effects) !== Object.prototype && Object.getPrototypeOf(o.effects) !== null)) throw new RecErr('source:effects_not_plain_object')
    const keys = Object.getOwnPropertyNames(o.effects)
    if (keys.length > LIMITS.maxEffectsPerSource) throw new RecErr('source:too_many_effects')
    const clean = Object.create(null)
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(P.expectedAnchors, k)) throw new RecErr('source:unknown_effect_label')
      const d = Object.getOwnPropertyDescriptor(o.effects, k)
      if (!d || typeof d.get === 'function' || typeof d.set === 'function' || !('value' in d)) throw new RecErr('source:effect_accessor')
      clean[k] = strictRecord(d.value, EFFECT_FIELDS, 'effect')
    }
    o.effects = clean
  } else { o.effects = Object.create(null) }
  return o
}
function sanitizeAnchor(a) { return strictRecord(a, ANCHOR_FIELDS, 'anchor') }
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58M = (() => { const m = Object.create(null); for (let i = 0; i < B58A.length; i++) m[B58A[i]] = i; return m })()
function b58decode(s) {
  if (typeof s !== 'string' || !s.length || s.length > 128) return null
  let n = 0n
  for (const ch of s) { const v = B58M[ch]; if (v === undefined) return null; n = n * 58n + BigInt(v) }
  let zeros = 0; for (const ch of s) { if (ch === '1') zeros++; else break }
  const out = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n }
  return Uint8Array.from([...new Array(zeros).fill(0), ...out])
}
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b)
  let s = ''; while (n > 0n) { s = B58A[Number(n % 58n)] + s; n /= 58n }
  let zeros = 0; for (const b of bytes) { if (b === 0) zeros++; else break }
  return '1'.repeat(zeros) + s
}
function b58canonical(s, len) { const d = b58decode(s); if (!d || d.length !== len) return false; return b58encode(d) === s }
const FORMS = {
  evm: v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v),
  btc: v => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v),
  'sol-sig': v => b58canonical(v, 64),
  'sol-hash': v => b58canonical(v, 32),
}
const HEXFORM = f => f === 'evm' || f === 'btc'
function formOk(form, v) { return Object.prototype.hasOwnProperty.call(FORMS, form) && FORMS[form](v) }
function eqForm(form, a, b) { return HEXFORM(form) ? a.toLowerCase() === b.toLowerCase() : a === b } // base58 EXACT
const own = (o, k) => o != null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k)
const isInt0 = n => Number.isSafeInteger(n) && n >= 0
const isStr = (x, max = 256) => typeof x === 'string' && x.length > 0 && x.length <= max
const isBaseIntStr = x => typeof x === 'string' && /^\d{1,40}$/.test(x)
const isScalar = x => (typeof x === 'string' && x.length >= 1 && x.length <= 64) || (typeof x === 'number' && Number.isFinite(x))
function ownMapKeys(v, where, maxKeyLen) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(where + ' must be a plain object map')
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) throw new TypeError(where + ' must have a plain prototype')
  const names = Object.getOwnPropertyNames(v)
  for (const k of names) {
    if (typeof k !== 'string' || !k.length || k.length > maxKeyLen) throw new TypeError(where + ' has an out-of-bounds key name')
    const d = Object.getOwnPropertyDescriptor(v, k)
    if (!d || typeof d.get === 'function' || typeof d.set === 'function' || !('value' in d)) throw new TypeError(where + ' has an accessor key')
  }
  return names
}
// Validate + return a SANITIZED null-proto policy snapshot (own-data only). evaluate() uses the
// snapshot consistently so no accessor/inherited value is ever re-read during evaluation.
function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('policy required')
  strictRecord(p, POLICY_FIELDS, 'policy')
  if (p.version !== 1) throw new TypeError('policy.version must be 1')
  if (!Number.isSafeInteger(p.minIndependentSources) || p.minIndependentSources < 2 || p.minIndependentSources > 64) throw new TypeError('minIndependentSources must be int in [2,64]')
  if (!isInt0(p.now)) throw new TypeError('now must be a non-negative integer')
  if (!Number.isSafeInteger(p.maxObsAgeMs) || p.maxObsAgeMs <= 0 || p.maxObsAgeMs > 86400000) throw new TypeError('maxObsAgeMs must be a positive integer <= 86400000')
  const snap = { version: p.version, minIndependentSources: p.minIndependentSources, now: p.now, maxObsAgeMs: p.maxObsAgeMs,
    chains: Object.create(null), trustedProviders: Object.create(null), expectedAnchors: Object.create(null) }
  const chainKeys = ownMapKeys(p.chains, 'chains', 64)
  if (!chainKeys.length) throw new TypeError('chains must be non-empty')
  if (chainKeys.length > LIMITS.maxChains) throw new TypeError('too many chains')
  for (const c of chainKeys) {
    const cfg = strictRecord(p.chains[c], CHAINCFG_FIELDS, 'chaincfg')
    if (!isScalar(cfg.networkId) || !isScalar(cfg.protocolVersion)) throw new TypeError('chains.' + c + ' networkId/protocolVersion must be non-empty scalars')
    if (!own(FORMS, cfg.idForm) || !own(FORMS, cfg.hashForm)) throw new TypeError('chains.' + c + ' needs valid idForm/hashForm')
    if (cfg.minConfirmations != null && !isInt0(cfg.minConfirmations)) throw new TypeError('chains.' + c + '.minConfirmations must be >= 0')
    snap.chains[c] = cfg
  }
  const provKeys = ownMapKeys(p.trustedProviders, 'trustedProviders', 128)
  if (!provKeys.length) throw new TypeError('trustedProviders must be non-empty')
  if (provKeys.length > LIMITS.maxProviders) throw new TypeError('too many providers')
  for (const idp of provKeys) {
    const t = strictRecord(p.trustedProviders[idp], PROVIDER_FIELDS, 'provider')
    if (!isStr(t.operatorGroup, 128) || !Array.isArray(t.chains) || !t.chains.length || t.chains.length > LIMITS.maxProviderChains) throw new TypeError('trustedProviders.' + idp + ' invalid')
    for (const c of t.chains) { if (!isStr(c, 64) || !own(snap.chains, c)) throw new TypeError('trustedProviders.' + idp + ' authorizes unknown chain') }
    snap.trustedProviders[idp] = { operatorGroup: t.operatorGroup, chains: t.chains.slice() }
  }
  const manKeys = ownMapKeys(p.expectedAnchors, 'expectedAnchors', 128)
  if (!manKeys.length || manKeys.length > LIMITS.maxExpected) throw new TypeError('expectedAnchors size out of bounds [1,' + LIMITS.maxExpected + ']')
  for (const k of manKeys) {
    const m = strictRecord(p.expectedAnchors[k], EFFECT_FIELDS, 'manifest')
    if (!isStr(m.kind, 32) || !isStr(m.chain, 64) || !own(snap.chains, m.chain)) throw new TypeError('expectedAnchors.' + k + ' content invalid')
    const cfg = snap.chains[m.chain]
    if (!formOk(cfg.idForm, m.identity) || !isStr(m.assetId, 128) || !isInt0(m.height) || !formOk(cfg.hashForm, m.blockHash) || !isBaseIntStr(m.amountBase)) throw new TypeError('expectedAnchors.' + k + ' content invalid')
    snap.expectedAnchors[k] = { kind: m.kind, chain: m.chain, identity: m.identity, assetId: m.assetId, height: m.height, blockHash: m.blockHash, amountBase: m.amountBase }
  }
  return snap
}
function sourceHealth(s, P) {
  const r = []
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { healthy: false, reasons: ['malformed_observation'], group: null, chain: null }
  if (s.error) r.push('read_error_or_missing')
  const trusted = isStr(s.providerId) && own(P.trustedProviders, s.providerId) ? P.trustedProviders[s.providerId] : null
  if (!trusted) r.push('untrusted_provider')
  const cfg = isStr(s.chain) && own(P.chains, s.chain) ? P.chains[s.chain] : null
  if (!cfg) r.push('unknown_chain')
  if (trusted && cfg && !trusted.chains.includes(s.chain)) r.push('provider_not_authorized_for_chain')
  if (cfg && s.networkId !== cfg.networkId) r.push('network_mismatch')
  if (cfg && s.protocolVersion !== cfg.protocolVersion) r.push('protocol_mismatch')
  if (s.historyComplete !== true) r.push('history_incomplete')
  if (s.paginationComplete !== true) r.push('pagination_incomplete')
  if (!isInt0(s.tipHeight)) r.push('bad_tip')
  if (!isInt0(s.finalizedHeight)) r.push('bad_finalized')
  if (isInt0(s.tipHeight) && isInt0(s.finalizedHeight) && s.finalizedHeight > s.tipHeight) r.push('impossible_finality')
  if (!isInt0(s.observedAt)) r.push('bad_timestamp')
  else if (s.observedAt > P.now) r.push('future_timestamp')
  else if ((P.now - s.observedAt) > P.maxObsAgeMs) r.push('stale_observation')
  return { healthy: r.length === 0, reasons: r, group: trusted ? trusted.operatorGroup : null, chain: cfg ? s.chain : null }
}
function anchorMatchesManifest(a, m, P) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false
  const cfg = P.chains[m.chain]
  if (a.kind !== m.kind || a.chain !== m.chain || a.assetId !== m.assetId) return false
  if (!formOk(cfg.idForm, a.identity) || !eqForm(cfg.idForm, a.identity, m.identity)) return false
  if (!isInt0(a.height) || a.height !== m.height) return false
  if (!formOk(cfg.hashForm, a.blockHash) || !eqForm(cfg.hashForm, a.blockHash, m.blockHash)) return false
  if (!isBaseIntStr(a.amountBase) || BigInt(a.amountBase) !== BigInt(m.amountBase)) return false
  return true
}
function effectMatches(e, m, cfg, s) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  if (e.kind !== m.kind || e.chain !== m.chain || s.chain !== m.chain || e.assetId !== m.assetId) return false
  if (!formOk(cfg.idForm, e.identity) || !eqForm(cfg.idForm, e.identity, m.identity)) return false
  if (!isInt0(e.height) || e.height !== m.height) return false
  if (!formOk(cfg.hashForm, e.blockHash) || !eqForm(cfg.hashForm, e.blockHash, m.blockHash)) return false
  if (!isBaseIntStr(e.amountBase) || BigInt(e.amountBase) !== BigInt(m.amountBase)) return false
  if (!(m.height <= s.finalizedHeight && s.finalizedHeight <= s.tipHeight)) return false
  const minC = cfg.minConfirmations != null ? cfg.minConfirmations : 1
  if ((s.finalizedHeight - m.height + 1) < minC) return false
  return true
}
function evaluate(anchors, sources, policy) {
  const P = validatePolicy(policy), reasons = new Set(), perAnchor = [], sourceEvidence = []
  if (!Array.isArray(anchors)) { reasons.add('anchors_not_array'); anchors = [] }
  if (!Array.isArray(sources)) { reasons.add('sources_not_array'); sources = [] }
  if (anchors.length > LIMITS.maxAnchors) { reasons.add('too_many_anchors'); anchors = anchors.slice(0, LIMITS.maxAnchors) }
  if (sources.length > LIMITS.maxSources) { reasons.add('too_many_sources'); sources = sources.slice(0, LIMITS.maxSources) }
  const healthy = []
  for (const s of sources) {
    let clean; try { clean = sanitizeSource(s, P) } catch (e) { const code = e && e.code ? e.code : 'source:malformed_observation'; reasons.add(code); sourceEvidence.push({ group: null, chain: null, healthy: false, reasons: [code] }); continue }
    const h = sourceHealth(clean, P)
    sourceEvidence.push({ group: h.group, chain: h.chain, healthy: h.healthy, reasons: h.reasons })
    if (h.healthy) healthy.push({ s: clean, group: h.group, chain: h.chain }); else h.reasons.forEach(x => reasons.add('source:' + x))
  }
  const supplied = new Map()
  for (const a0 of anchors) {
    let a; try { a = sanitizeAnchor(a0) } catch (e) { reasons.add(e && e.code ? e.code : 'malformed_anchor'); continue }
    const eid = a.effect_id
    if (!isStr(eid, 128)) { reasons.add('malformed_anchor_id'); continue }
    if (!own(P.expectedAnchors, eid)) { reasons.add('unexpected_anchor'); continue }
    if (supplied.has(eid)) { if (!anchorMatchesManifest(a, P.expectedAnchors[eid], P)) reasons.add('duplicate_anchor_conflict'); continue } // 2nd copy must also equal manifest
    supplied.set(eid, a)
  }
  for (const eid of Object.keys(P.expectedAnchors)) {
    const m = P.expectedAnchors[eid], cfg = P.chains[m.chain], a = supplied.get(eid), why = []
    if (!a) why.push('missing_expected_anchor')
    else if (!anchorMatchesManifest(a, m, P)) why.push('supplied_anchor_mismatch')
    const qualified = healthy.filter(x => x.chain === m.chain)
    if (qualified.length < P.minIndependentSources) why.push('insufficient_qualified_sources')
    const agree = new Set(); let disagreement = false
    for (const { s, group } of qualified) {                        // order-independent: scan ALL
      const e = own(s.effects, eid) ? s.effects[eid] : undefined
      if (e === undefined) { disagreement = true; continue }        // qualified source OMITS expected effect = disagreement
      if (effectMatches(e, m, cfg, s)) agree.add(group); else disagreement = true
    }
    if (disagreement) why.push('trusted_source_disagreement')       // ANY contradiction pauses, regardless of order/quorum
    if (agree.size < P.minIndependentSources) why.push('insufficient_final_canonical_matches')
    const ok = why.length === 0
    if (!ok) why.forEach(x => reasons.add('anchor:' + x))
    perAnchor.push({ effect_id: eid, ok, why, agreeing_groups: agree.size })
  }
  return { status: reasons.size === 0 ? 'ok' : 'pause', reasons: [...reasons],
    evidence: { required_per_chain: P.minIndependentSources, sources: sourceEvidence, anchors: perAnchor } }
}
module.exports = { evaluate, sourceHealth, validatePolicy, formOk, eqForm, b58encode, b58decode, b58canonical }
