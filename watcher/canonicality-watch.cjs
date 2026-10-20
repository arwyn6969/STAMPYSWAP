'use strict'
// Canonicality & reorg CHECKER — PURE detection-only decision logic (NOT a live/enforced watchdog;
// no I/O, holds nothing, never resolves/fences/mints/releases). All EXPECTED values live in POLICY
// (trusted), never in observations (a provider must not assert its own network/protocol/operator).
// Fail-closed: malformed policy THROWS (non-bypassable); an empty/omitted expected inventory can
// NEVER read as healthy; a missing/errored/ambiguous read is never zero/success. provider→operator
// mapping is a CONFIG ATTESTATION in policy, not proof of real independence.
function isInt(n) { return Number.isSafeInteger(n) }
function isBaseInt(s) { return typeof s === 'string' && /^\d{1,40}$/.test(s) }   // exact base-unit integer, string only
function hashOk(form, v) {
  if (typeof v !== 'string') return false
  if (form === 'evm') return /^0x[0-9a-f]{64}$/i.test(v)
  if (form === 'btc') return /^[0-9a-f]{64}$/i.test(v)
  if (form === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(v) // base58 (pubkey/sig/blockhash)
  return false
}
function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new TypeError('policy required')
  if (!isInt(p.minIndependentSources) || p.minIndependentSources < 2) throw new TypeError('policy.minIndependentSources must be an integer >= 2')
  if (!isInt(p.now) || p.now < 0) throw new TypeError('policy.now (ms) must be a non-negative integer')
  if (!isInt(p.maxObsAgeMs) || p.maxObsAgeMs <= 0) throw new TypeError('policy.maxObsAgeMs must be a positive integer')
  if (!p.chains || typeof p.chains !== 'object' || !Object.keys(p.chains).length) throw new TypeError('policy.chains must be a non-empty map')
  for (const [c, cfg] of Object.entries(p.chains)) {
    if (!cfg || typeof cfg !== 'object') throw new TypeError('policy.chains.' + c + ' invalid')
    if (cfg.networkId == null) throw new TypeError('policy.chains.' + c + '.networkId required')
    if (cfg.protocolVersion == null) throw new TypeError('policy.chains.' + c + '.protocolVersion required')
    if (!['evm', 'btc', 'solana'].includes(cfg.hashForm)) throw new TypeError('policy.chains.' + c + '.hashForm must be evm|btc|solana')
  }
  if (!p.trustedProviders || typeof p.trustedProviders !== 'object' || !Object.keys(p.trustedProviders).length) throw new TypeError('policy.trustedProviders must be a non-empty map')
  for (const [id, cfg] of Object.entries(p.trustedProviders)) {
    if (!cfg || typeof cfg !== 'object' || !cfg.operatorGroup || typeof cfg.operatorGroup !== 'string') throw new TypeError('policy.trustedProviders.' + id + '.operatorGroup required')
  }
  if (!Array.isArray(p.expectedEffectIds) || !p.expectedEffectIds.length) throw new TypeError('policy.expectedEffectIds must be a non-empty inventory (empty/omitted cannot mean healthy)')
}
function sourceHealth(s, P) {
  const r = []
  if (!s || typeof s !== 'object') return { healthy: false, reasons: ['malformed_observation'], group: null }
  const prov = (typeof s.providerId === 'string') ? P.trustedProviders[s.providerId] : undefined
  if (!prov) r.push('untrusted_provider')                               // provider must be pinned IN POLICY
  const cfg = (typeof s.chain === 'string') ? P.chains[s.chain] : undefined
  if (!cfg) r.push('unknown_chain')
  if (cfg && s.networkId !== cfg.networkId) r.push('network_mismatch')   // expected comes from POLICY
  if (cfg && s.protocolVersion !== cfg.protocolVersion) r.push('protocol_mismatch')
  if (s.historyComplete !== true) r.push('history_incomplete')           // explicit POSITIVE completeness
  if (s.paginationComplete !== true) r.push('pagination_incomplete')
  if (!isInt(s.tipHeight)) r.push('no_tip')
  if (!isInt(s.finalizedHeight)) r.push('no_finalized_height')
  if (!isInt(s.observedAt)) r.push('no_timestamp')
  else if (s.observedAt > P.now) r.push('future_timestamp')
  else if ((P.now - s.observedAt) > P.maxObsAgeMs) r.push('stale_observation')
  return { healthy: r.length === 0, reasons: r, group: prov ? prov.operatorGroup : null }
}
function effectMatches(e, a, cfg) {
  return e && typeof e === 'object'
    && e.chain === a.chain && e.identity === a.identity && e.assetId === a.assetId
    && isInt(e.height) && e.height === a.height
    && hashOk(cfg.hashForm, e.blockHash) && e.blockHash.toLowerCase() === a.blockHash.toLowerCase()
    && isBaseInt(String(e.amountBase)) && BigInt(String(e.amountBase)) === BigInt(String(a.amountBase))
}
function evaluate(anchors, sources, policy) {
  validatePolicy(policy)                   // THROWS on malformed policy — non-bypassable
  const P = policy, reasons = new Set(), perAnchor = [], sourceEvidence = []
  // 1) healthy sources, independence BY OPERATOR GROUP (from policy; a config attestation, not proof)
  const groups = new Map()
  for (const s of (sources || [])) {
    const h = sourceHealth(s, P)
    sourceEvidence.push({ providerId: s && s.providerId, group: h.group, healthy: h.healthy, reasons: h.reasons })
    if (!h.healthy) { h.reasons.forEach(x => reasons.add('source:' + x)); continue }
    if (groups.has(h.group)) reasons.add('sources_share_operator_group_not_independent')
    else groups.set(h.group, s)
  }
  const independent = [...groups.values()]
  if (independent.length < P.minIndependentSources) reasons.add('insufficient_independent_sources')
  // 2) dedupe anchors + detect conflicts
  const byId = new Map()
  for (const a of (anchors || [])) {
    if (!a || a.effect_id == null) { reasons.add('anchor_missing_effect_id'); continue }
    const sig = JSON.stringify([a.chain, a.identity, a.assetId, a.height, a.blockHash, a.amountBase])
    if (byId.has(a.effect_id) && byId.get(a.effect_id).sig !== sig) reasons.add('duplicate_anchor_conflict')
    else byId.set(a.effect_id, { a, sig })
  }
  // 3) EVERY expected effect in the inventory must be present + canonically matched (omitted != healthy)
  for (const eid of P.expectedEffectIds) {
    const entry = byId.get(eid)
    if (!entry) { reasons.add('missing_expected_anchor'); perAnchor.push({ effect_id: eid, ok: false, why: ['missing_expected_anchor'] }); continue }
    const a = entry.a, why = []
    const cfg = (typeof a.chain === 'string') ? P.chains[a.chain] : undefined
    if (!cfg) why.push('anchor_unknown_chain')
    if (!a.identity || typeof a.identity !== 'string') why.push('missing_tx_identity')
    if (!a.assetId || typeof a.assetId !== 'string') why.push('missing_asset_identity')
    if (!isInt(a.height) || a.height < 0) why.push('bad_height')
    if (cfg && !hashOk(cfg.hashForm, a.blockHash)) why.push('bad_block_hash_form')
    if (!isBaseInt(String(a.amountBase))) why.push('bad_amount_precision')
    if (!why.length) {
      let match = 0, conflict = false
      for (const s of independent) {
        const e = s.effects && Object.prototype.hasOwnProperty.call(s.effects, eid) ? s.effects[eid] : undefined
        if (e === undefined) continue                                   // missing != match
        if (!effectMatches(e, a, cfg)) { conflict = true; continue }    // present but different tx/asset/amt/block = conflict
        if (s.finalizedHeight >= a.height) match++                      // exact + finalized on an independent operator
      }
      if (conflict) why.push('observation_identity_or_reorg_mismatch')
      if (match < P.minIndependentSources) why.push('insufficient_final_canonical_matches')
    }
    const ok = why.length === 0
    if (!ok) why.forEach(x => reasons.add('anchor:' + x))
    perAnchor.push({ effect_id: eid, ok, why })
  }
  return { status: reasons.size === 0 ? 'ok' : 'pause', reasons: [...reasons],
    evidence: { independent_operator_groups: independent.length, required: P.minIndependentSources, sources: sourceEvidence, anchors: perAnchor } }
}
module.exports = { evaluate, sourceHealth, validatePolicy, hashOk }
