'use strict'
// Canonicality & reorg CHECKER v3 — PURE detection-only (NOT a live watchdog; no I/O, holds
// nothing, never resolves/fences/mints/releases). Expected values are POLICY-authoritative; a
// provider cannot assert its own network/protocol/operator/chain. Fail-closed: malformed POLICY
// THROWS (non-bypassable); malformed OBSERVATIONS/ANCHORS pause (never crash); a missing/errored/
// ambiguous/disagreeing read is never zero/success. Operator-group independence is a config
// attestation, not proof. own-property lookups only (no __proto__/inherited key bypass).
const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
const isInt0 = n => Number.isSafeInteger(n) && n >= 0
const isStr = (x, max = 256) => typeof x === 'string' && x.length > 0 && x.length <= max
const isBaseIntStr = x => typeof x === 'string' && /^\d{1,40}$/.test(x)   // STRING only — never String()-coerce a number
const FORMS = {
  evm: v => /^0x[0-9a-f]{64}$/i.test(v),                     // 32-byte, 0x
  btc: v => /^[0-9a-f]{64}$/i.test(v),                       // 32-byte hex
  'sol-sig': v => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v),   // 64-byte base58 signature
  'sol-hash': v => /^[1-9A-HJ-NP-Za-km-z]{32,45}$/.test(v),  // 32-byte base58 blockhash/pubkey
}
const formOk = (form, v) => typeof v === 'string' && own(FORMS, form) && FORMS[form](v)
function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new TypeError('policy required')
  if (p.version !== 1) throw new TypeError('policy.version must be 1')
  if (!Number.isSafeInteger(p.minIndependentSources) || p.minIndependentSources < 2) throw new TypeError('policy.minIndependentSources must be an integer >= 2')
  if (!isInt0(p.now)) throw new TypeError('policy.now (ms) must be a non-negative integer')
  if (!Number.isSafeInteger(p.maxObsAgeMs) || p.maxObsAgeMs <= 0) throw new TypeError('policy.maxObsAgeMs must be a positive integer')
  if (!p.chains || typeof p.chains !== 'object' || !Object.keys(p.chains).length) throw new TypeError('policy.chains must be a non-empty map')
  for (const c of Object.keys(p.chains)) {
    const cfg = p.chains[c]
    if (!cfg || typeof cfg !== 'object') throw new TypeError('policy.chains.' + c + ' invalid')
    if (cfg.networkId == null || cfg.protocolVersion == null) throw new TypeError('policy.chains.' + c + ' needs networkId + protocolVersion')
    if (!own(FORMS, cfg.idForm) || !own(FORMS, cfg.hashForm)) throw new TypeError('policy.chains.' + c + ' needs valid idForm + hashForm')
    if (cfg.minConfirmations != null && !isInt0(cfg.minConfirmations)) throw new TypeError('policy.chains.' + c + '.minConfirmations must be >= 0')
  }
  if (!p.trustedProviders || typeof p.trustedProviders !== 'object' || !Object.keys(p.trustedProviders).length) throw new TypeError('policy.trustedProviders must be a non-empty map')
  for (const id of Object.keys(p.trustedProviders)) {
    const t = p.trustedProviders[id]
    if (!t || typeof t !== 'object' || !isStr(t.operatorGroup) || !Array.isArray(t.chains) || !t.chains.length) throw new TypeError('policy.trustedProviders.' + id + ' needs operatorGroup + non-empty chains[]')
    for (const c of t.chains) if (!own(p.chains, c)) throw new TypeError('policy.trustedProviders.' + id + ' authorizes unknown chain ' + c)
  }
  if (!Array.isArray(p.expectedEffectIds) || !p.expectedEffectIds.length) throw new TypeError('policy.expectedEffectIds must be a non-empty inventory')
  const seen = new Set()
  for (const id of p.expectedEffectIds) { if (!isStr(id, 128)) throw new TypeError('expectedEffectIds must be bounded non-empty strings'); if (seen.has(id)) throw new TypeError('expectedEffectIds must be unique'); seen.add(id) }
}
function sourceHealth(s, P) {
  const r = []
  if (!s || typeof s !== 'object') return { healthy: false, reasons: ['malformed_observation'], group: null, chain: null }
  if (s.error) r.push('read_error_or_missing')                                   // cached+timeout must NOT count
  const trusted = isStr(s.providerId) && own(P.trustedProviders, s.providerId) ? P.trustedProviders[s.providerId] : null
  if (!trusted) r.push('untrusted_provider')                                     // own-prop only (no __proto__)
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
  if (!Number.isSafeInteger(s.observedAt)) r.push('no_timestamp')
  else if (s.observedAt > P.now) r.push('future_timestamp')
  else if ((P.now - s.observedAt) > P.maxObsAgeMs) r.push('stale_observation')
  return { healthy: r.length === 0, reasons: r, group: trusted ? trusted.operatorGroup : null, chain: cfg ? s.chain : null }
}
function anchorWellFormed(a, P) {
  const why = []
  if (!a || typeof a !== 'object') return ['malformed_anchor']
  if (!isStr(a.kind, 32)) why.push('missing_kind')
  const cfg = isStr(a.chain) && own(P.chains, a.chain) ? P.chains[a.chain] : null
  if (!cfg) { why.push('anchor_unknown_chain'); return why }
  if (!formOk(cfg.idForm, a.identity)) why.push('bad_tx_identity')
  if (!isStr(a.assetId, 128)) why.push('missing_asset_identity')
  if (!isInt0(a.height)) why.push('bad_height')
  if (!formOk(cfg.hashForm, a.blockHash)) why.push('bad_block_hash_form')
  if (!isBaseIntStr(a.amountBase)) why.push('bad_amount_precision')   // numbers rejected (no String() coercion)
  return why
}
function effectMatches(e, a, cfg, s) {
  // bind chain to BOTH the source and the anchor; match kind + exact identity/asset/amount/block;
  // enforce height ordering 0 <= anchor <= finalized <= tip + per-chain confirmations.
  if (!e || typeof e !== 'object') return false
  if (e.kind !== a.kind) return false
  if (e.chain !== a.chain || s.chain !== a.chain) return false            // no cross-chain effect counting
  if (!formOk(cfg.idForm, e.identity) || e.identity !== a.identity) return false
  if (e.assetId !== a.assetId) return false
  if (!isInt0(e.height) || e.height !== a.height) return false
  if (!formOk(cfg.hashForm, e.blockHash) || e.blockHash.toLowerCase() !== a.blockHash.toLowerCase()) return false
  if (!isBaseIntStr(e.amountBase) || BigInt(e.amountBase) !== BigInt(a.amountBase)) return false
  if (!(a.height <= s.finalizedHeight && s.finalizedHeight <= s.tipHeight)) return false
  const minC = (cfg.minConfirmations != null) ? cfg.minConfirmations : 1
  if ((s.finalizedHeight - a.height + 1) < minC) return false
  return true
}
function evaluate(anchors, sources, policy) {
  validatePolicy(policy)                                                 // THROWS on malformed policy
  const P = policy, reasons = new Set(), perAnchor = [], sourceEvidence = []
  const expected = new Set(P.expectedEffectIds)
  // healthy sources (errored/unhealthy excluded, not silently trusted)
  const healthy = []
  for (const s of (Array.isArray(sources) ? sources : [])) {
    const h = sourceHealth(s, P)
    sourceEvidence.push({ providerId: s && s.providerId, group: h.group, chain: h.chain, healthy: h.healthy, reasons: h.reasons })
    if (h.healthy) healthy.push({ s, group: h.group }); else h.reasons.forEach(x => reasons.add('source:' + x))
  }
  // anchors: dedupe + reject duplicates-with-conflict + reject UNEXPECTED/extra + collect well-formed
  const byId = new Map()
  for (const a of (Array.isArray(anchors) ? anchors : [])) {
    if (!a || a.effect_id == null || !isStr(a.effect_id, 128)) { reasons.add('malformed_anchor_id'); continue }
    if (!expected.has(a.effect_id)) { reasons.add('unexpected_anchor'); continue }   // exact coverage only
    const sig = JSON.stringify([a.kind, a.chain, a.identity, a.assetId, a.height, a.blockHash, a.amountBase])
    if (byId.has(a.effect_id) && byId.get(a.effect_id).sig !== sig) reasons.add('duplicate_anchor_conflict')
    else if (!byId.has(a.effect_id)) byId.set(a.effect_id, { a, sig })
  }
  for (const eid of P.expectedEffectIds) {
    const entry = byId.get(eid)
    if (!entry) { reasons.add('missing_expected_anchor'); perAnchor.push({ effect_id: eid, ok: false, why: ['missing_expected_anchor'] }); continue }
    const a = entry.a, wf = anchorWellFormed(a, P)
    if (wf.length) { wf.forEach(x => reasons.add('anchor:' + x)); perAnchor.push({ effect_id: eid, ok: false, why: wf }); continue }
    const cfg = P.chains[a.chain]
    // candidates: healthy sources ON THE ANCHOR CHAIN; dedupe operator groups PER CHAIN
    const perGroup = new Map()
    for (const { s, group } of healthy) { if (s.chain === a.chain && !perGroup.has(group)) perGroup.set(group, s) }
    let match = 0, conflict = false
    for (const s of perGroup.values()) {
      const e = own(s.effects, eid) ? s.effects[eid] : undefined
      if (e === undefined) continue
      if (effectMatches(e, a, cfg, s)) match++
      else conflict = true                                              // present but disagrees → conflict
    }
    const why = []
    if (conflict) why.push('trusted_source_disagreement')               // pause even if quorum reached
    if (match < P.minIndependentSources) why.push('insufficient_final_canonical_matches')
    const ok = why.length === 0
    if (!ok) why.forEach(x => reasons.add('anchor:' + x))
    perAnchor.push({ effect_id: eid, ok, why, matched_groups: match })
  }
  return { status: reasons.size === 0 ? 'ok' : 'pause', reasons: [...reasons],
    evidence: { required_per_chain: P.minIndependentSources, sources: sourceEvidence, anchors: perAnchor } }
}
module.exports = { evaluate, sourceHealth, validatePolicy, formOk, anchorWellFormed }
