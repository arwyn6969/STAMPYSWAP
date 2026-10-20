'use strict'
const test = require('node:test'); const assert = require('node:assert')
const { evaluate } = require('./canonicality-watch.cjs')
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64)
// two INDEPENDENT providers (distinct fingerprints)
const s = (over) => Object.assign({ sourceId: 's1', providerFingerprint: 'fp-A@hostA', chain: 'base-mainnet',
  networkId: 8453, expectedNetworkId: 8453, tipHeight: 100, finalizedHeight: 100, historyPresent: true,
  paginationComplete: true, protocolVersion: 1, supportedProtocolVersion: 1,
  blockHashByHeight: { '50': H1 }, amountByEffect: { e1: '1000' } }, over)
const A = { effect_id: 'e1', kind: 'burn', chain: 'base-mainnet', identity: '0xabc', height: 50, blockHash: H1, amountBase: '1000' }
const P = { minIndependentSources: 2, referenceTip: 100, maxTipLag: 2 }
const two = () => [s(), s({ sourceId: 's2', providerFingerprint: 'fp-B@hostB' })]

test('happy: 2 independent, final, agreeing, exact amount -> ok', () => {
  const r = evaluate([A], two(), P); assert.equal(r.status, 'ok'); assert.equal(r.evidence.independent_sources, 2)
})
test('INDEPENDENCE: same provider relabeled as 2 sources -> counts once -> pause', () => {
  const r = evaluate([A], [s({ sourceId: 's1' }), s({ sourceId: 's2-relabel' })], P) // same fp
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('sources_not_independent_labels_insufficient'))
  assert.ok(r.reasons.includes('insufficient_independent_sources'))
})
test('reorg: same height, different hash -> pause', () => {
  const r = evaluate([A], [s(), s({ sourceId: 's2', providerFingerprint: 'fp-B', blockHashByHeight: { '50': H2 } })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:reorg_or_fork_hash_mismatch'))
})
test('malformed/oversized observation -> unhealthy -> pause', () => {
  const r = evaluate([A], [s(), s({ sourceId: 's2', providerFingerprint: 'fp-B', blockHashByHeight: { '50': 'not-a-hash' } })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:malformed_or_oversized_observation'))
})
test('stale observation (obs age) -> pause', () => {
  const pol = Object.assign({ now: 10_000, maxObsAgeMs: 1000 }, P)
  const r = evaluate([A], [s({ observedAt: 9_500 }), s({ sourceId: 's2', providerFingerprint: 'fp-B', observedAt: 1_000 })], pol)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:stale_observation'))
})
test('missing tx identity on anchor -> pause', () => {
  const r = evaluate([{ ...A, identity: undefined }], two(), P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:missing_tx_identity'))
})
test('amount precision: non-integer amount -> bad_amount_precision', () => {
  const r = evaluate([{ ...A, amountBase: '10.5' }], two(), P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:bad_amount_precision'))
})
test('amount mismatch across sources -> amount_unconfirmed', () => {
  const r = evaluate([A], [s({ amountByEffect: { e1: '999' } }), s({ sourceId: 's2', providerFingerprint: 'fp-B', amountByEffect: { e1: '999' } })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:amount_unconfirmed'))
})
test('duplicate anchors with conflicting content -> duplicate_anchor_conflict', () => {
  const r = evaluate([A, { ...A, blockHash: H2 }], two(), P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('duplicate_anchor_conflict'))
})
test('not final on enough independent sources -> pause', () => {
  const r = evaluate([A], [s({ finalizedHeight: 49 }), s({ sourceId: 's2', providerFingerprint: 'fp-B', finalizedHeight: 49 })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:not_final_on_enough_independent_sources'))
})
test('read error = missing (never zero/success) -> pause', () => {
  const r = evaluate([A], [s(), s({ sourceId: 's2', providerFingerprint: 'fp-B', error: true })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:read_error_or_missing'))
})
test('no provider fingerprint -> cannot establish independence -> pause', () => {
  const r = evaluate([A], [s({ providerFingerprint: null }), s({ sourceId: 's2', providerFingerprint: null })], P)
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:no_provider_fingerprint'))
})
