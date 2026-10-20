'use strict'
// Canonicality & reorg checker — PURE decision logic (NOT a live/enforced watchdog; it does no
// I/O, holds nothing, and never resolves/fences/mints/releases). A separate integrator would feed
// it real observations and act on the signal. Fail-closed: a missing/errored/malformed read is
// NEVER treated as zero or cached success. Source LABELS do not prove independence — agreement is
// counted per distinct providerFingerprint, not per sourceId.
const MAX_HEIGHT_KEYS = 100000 // oversized-observation guard
function isHash(h) { return typeof h === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(h) }
function isBaseInt(s) { return typeof s === 'string' && /^\d{1,40}$/.test(s) } // exact base-unit integer
function structOk(s) {
  if (!s || typeof s !== 'object') return false
  if (s.blockHashByHeight != null) {
    if (typeof s.blockHashByHeight !== 'object' || Array.isArray(s.blockHashByHeight)) return false
    const keys = Object.keys(s.blockHashByHeight)
    if (keys.length > MAX_HEIGHT_KEYS) return false
    for (const k of keys) { if (!/^\d{1,12}$/.test(k) || !isHash(s.blockHashByHeight[k])) return false }
  }
  return true
}
function sourceHealth(s, policy) {
  const r = []
  if (!structOk(s)) return { healthy: false, reasons: ['malformed_or_oversized_observation'], fp: null }
  if (s.error) r.push('read_error_or_missing')
  if (s.networkId !== s.expectedNetworkId) r.push('network_mismatch')
  if (s.historyPresent === false) r.push('missing_history')
  if (s.paginationComplete === false) r.push('incomplete_pagination')
  if (s.protocolVersion !== s.supportedProtocolVersion) r.push('unknown_protocol_version')
  if (!Number.isSafeInteger(s.tipHeight)) r.push('no_tip')
  else if (policy.referenceTip != null && (policy.referenceTip - s.tipHeight) > (policy.maxTipLag || 0)) r.push('stale_tip')
  if (policy.now != null && policy.maxObsAgeMs != null) {
    if (!Number.isSafeInteger(s.observedAt) || (policy.now - s.observedAt) > policy.maxObsAgeMs) r.push('stale_observation')
  }
  // fingerprint = what actually distinguishes a provider (endpoint+operator), NOT the label/sourceId
  const fp = s.providerFingerprint || null
  if (!fp) r.push('no_provider_fingerprint')
  return { healthy: r.length === 0, reasons: r, fp }
}
function dedupeAnchors(anchors, reasons) {
  const byId = new Map()
  for (const a of anchors) {
    const k = a && a.effect_id
    if (k == null) { reasons.add('anchor:missing_effect_id'); continue }
    const sig = JSON.stringify([a.chain, a.height, a.blockHash, a.amountBase, a.identity])
    if (!byId.has(k)) byId.set(k, { a, sig })
    else if (byId.get(k).sig !== sig) reasons.add('duplicate_anchor_conflict') // same id, different content
  }
  return [...byId.values()].map(v => v.a)
}
function evaluate(anchors, sources, policy) {
  const P = Object.assign({ minIndependentSources: 2, maxTipLag: 0 }, policy || {})
  const reasons = new Set(); const perAnchor = []; const sourceEvidence = []
  // 1) source health + independence (by fingerprint, not label)
  const healthyByFp = new Map()
  for (const s of (sources || [])) {
    const h = sourceHealth(s, P)
    sourceEvidence.push({ sourceId: s && s.sourceId, fp: h.fp, healthy: h.healthy, reasons: h.reasons })
    if (!h.healthy) { h.reasons.forEach(x => reasons.add('source:' + x)); continue }
    if (healthyByFp.has(h.fp)) reasons.add('sources_not_independent_labels_insufficient') // two labels, one provider
    else healthyByFp.set(h.fp, s) // count a fingerprint ONCE
  }
  const independent = [...healthyByFp.values()]
  if (independent.length < P.minIndependentSources) reasons.add('insufficient_independent_sources')
  // 2) per-anchor canonicality (dedupe anchors first)
  for (const a of dedupeAnchors(anchors || [], reasons)) {
    const why = []
    if (!a.chain || typeof a.chain !== 'string') why.push('missing_chain')
    if (!a.identity || typeof a.identity !== 'string') why.push('missing_tx_identity')
    if (!isHash(a.blockHash) || !Number.isSafeInteger(a.height) || a.height < 0) why.push('bad_anchor')
    if (a.amountBase != null && !isBaseInt(String(a.amountBase))) why.push('bad_amount_precision')
    if (why.length) { why.forEach(x => reasons.add('anchor:' + x)); perAnchor.push({ effect_id: a.effect_id, ok: false, why }); continue }
    let agree = 0, finalAgree = 0, amountAgree = 0, conflict = false
    for (const s of independent) {
      const seen = s.blockHashByHeight && Object.prototype.hasOwnProperty.call(s.blockHashByHeight, String(a.height)) ? s.blockHashByHeight[String(a.height)] : undefined
      if (seen === undefined) continue                              // missing != agreement
      if (seen.toLowerCase() !== a.blockHash.toLowerCase()) { conflict = true; continue } // same height, different hash = reorg/fork
      agree++
      if (Number.isSafeInteger(s.finalizedHeight) && s.finalizedHeight >= a.height) finalAgree++
      const amt = s.amountByEffect && Object.prototype.hasOwnProperty.call(s.amountByEffect, a.effect_id) ? String(s.amountByEffect[a.effect_id]) : undefined
      if (amt !== undefined && isBaseInt(amt) && a.amountBase != null && BigInt(amt) === BigInt(String(a.amountBase))) amountAgree++
    }
    if (conflict) why.push('reorg_or_fork_hash_mismatch')
    if (agree < P.minIndependentSources) why.push('insufficient_canonical_agreement')
    if (finalAgree < P.minIndependentSources) why.push('not_final_on_enough_independent_sources')
    if (a.amountBase != null && amountAgree < P.minIndependentSources) why.push('amount_unconfirmed')
    const ok = why.length === 0
    if (!ok) why.forEach(x => reasons.add('anchor:' + x))
    perAnchor.push({ effect_id: a.effect_id, ok, why })
  }
  return { status: reasons.size === 0 ? 'ok' : 'pause', reasons: [...reasons],
    evidence: { independent_sources: independent.length, sources: sourceEvidence, anchors: perAnchor } }
}
module.exports = { evaluate, sourceHealth }
