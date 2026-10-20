'use strict'
const test = require('node:test'); const assert = require('node:assert')
const { evaluate, validatePolicy } = require('./canonicality-watch.cjs')
const H = 'a'.repeat(64), HX = '0x' + 'a'.repeat(64), SOLSIG = '5'.repeat(64) // base58-ish
const POL = () => ({ minIndependentSources: 2, now: 10000, maxObsAgeMs: 5000,
  chains: { 'base-mainnet': { networkId: 8453, protocolVersion: 1, hashForm: 'evm' },
            'bitcoin-mainnet': { networkId: 'btc', protocolVersion: 1, hashForm: 'btc' },
            'solana-mainnet': { networkId: 'sol', protocolVersion: 1, hashForm: 'solana' } },
  trustedProviders: { pA: { operatorGroup: 'gA' }, pB: { operatorGroup: 'gB' } },
  expectedEffectIds: ['e1'] })
const A = { effect_id: 'e1', chain: 'base-mainnet', identity: '0xtx', assetId: 'ACME', height: 50, blockHash: HX, amountBase: '1000' }
const eff = { chain: 'base-mainnet', identity: '0xtx', assetId: 'ACME', height: 50, blockHash: HX, amountBase: '1000' }
const src = (over) => Object.assign({ providerId: 'pA', chain: 'base-mainnet', networkId: 8453, protocolVersion: 1,
  historyComplete: true, paginationComplete: true, tipHeight: 100, finalizedHeight: 100, observedAt: 9000,
  effects: { e1: { ...eff } } }, over)
const two = () => [src(), src({ providerId: 'pB' })]

// ---- counterexamples that MUST no longer be false-green ----
test('CE1: evaluate([],[],{minIndependentSources:0}) THROWS (not ok)', () => {
  assert.throws(() => evaluate([], [], { minIndependentSources: 0 }), /minIndependentSources/)
})
test('CE2: provider-asserted/omitted expected values no longer pass -> pause', () => {
  // sources with undefined networkId/protocol + untrusted provider + no completeness
  const bad = [{ providerFingerprint: 'A', tipHeight: 1, finalizedHeight: 1 }, { providerFingerprint: 'B', tipHeight: 1, finalizedHeight: 1 }]
  const r = evaluate([{ effect_id: 'claim', chain: 'bitcoin-mainnet', identity: 'not-a-transaction', height: 1, blockHash: H }],
    bad, Object.assign(POL(), { expectedEffectIds: ['claim'] }))
  assert.equal(r.status, 'pause')
  assert.ok(r.reasons.includes('source:untrusted_provider'))
})
// ---- malformed policy (all THROW) ----
for (const [name, mut] of [
  ['minIndependentSources<2', p => p.minIndependentSources = 1],
  ['missing chains', p => delete p.chains],
  ['missing trustedProviders', p => delete p.trustedProviders],
  ['missing expectedEffectIds', p => delete p.expectedEffectIds],
  ['empty expectedEffectIds', p => p.expectedEffectIds = []],
  ['missing maxObsAgeMs', p => delete p.maxObsAgeMs],
  ['bad hashForm', p => p.chains['base-mainnet'].hashForm = 'nope'],
]) test('malformed policy throws: ' + name, () => { const p = POL(); mut(p); assert.throws(() => evaluate([A], two(), p)) })

test('happy: 2 operator groups, exact match, finalized, fresh -> ok', () => {
  const r = evaluate([A], two(), POL()); assert.equal(r.status, 'ok'); assert.equal(r.evidence.independent_operator_groups, 2)
})
test('two providers SAME operator group -> not independent -> pause', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pA' })], POL()) // both gA
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('sources_share_operator_group_not_independent'))
})
test('untrusted provider -> pause', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pX' })], POL()); assert.equal(r.status, 'pause')
  assert.ok(r.reasons.includes('source:untrusted_provider'))
})
test('network mismatch (obs lies) -> pause', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB', networkId: 1 })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:network_mismatch'))
})
test('protocol mismatch -> pause', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB', protocolVersion: 2 })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:protocol_mismatch'))
})
test('history/pagination not explicitly true -> pause', () => {
  const r = evaluate([A], [src({ historyComplete: undefined }), src({ providerId: 'pB', paginationComplete: false })], POL())
  assert.equal(r.status, 'pause')
})
test('future timestamp -> pause', () => {
  const r = evaluate([A], [src({ observedAt: 99999 }), src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:future_timestamp'))
})
test('stale observation -> pause', () => {
  const r = evaluate([A], [src({ observedAt: 1000 }), src({ providerId: 'pB', observedAt: 1000 })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('source:stale_observation'))
})
test('omitted expected anchor (inventory has e1 but none supplied) -> pause', () => {
  const r = evaluate([], two(), POL()); assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('missing_expected_anchor'))
})
test('exact identity mismatch (different txid) -> pause conflict', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB', effects: { e1: { ...eff, identity: '0xOTHER' } } })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:observation_identity_or_reorg_mismatch'))
})
test('amount mismatch in observation -> not counted -> pause', () => {
  const r = evaluate([A], [src({ effects: { e1: { ...eff, amountBase: '999' } } }), src({ providerId: 'pB', effects: { e1: { ...eff, amountBase: '999' } } })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:insufficient_final_canonical_matches'))
})
test('unsafe/non-string amount on anchor -> bad_amount_precision', () => {
  const r = evaluate([{ ...A, amountBase: 1e40 }], two(), POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:bad_amount_precision'))
})
test('not finalized on enough groups -> pause', () => {
  const r = evaluate([A], [src({ finalizedHeight: 49 }), src({ providerId: 'pB', finalizedHeight: 49 })], POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('anchor:insufficient_final_canonical_matches'))
})
test('duplicate conflicting anchors -> pause', () => {
  const r = evaluate([A, { ...A, blockHash: '0x' + 'b'.repeat(64) }], two(), POL())
  assert.equal(r.status, 'pause'); assert.ok(r.reasons.includes('duplicate_anchor_conflict'))
})
test('solana base58 block/sig form accepted (positive)', () => {
  const pol = POL(); pol.expectedEffectIds = ['s1']
  const sa = { effect_id: 's1', chain: 'solana-mainnet', identity: SOLSIG, assetId: 'KEVIN', height: 10, blockHash: SOLSIG, amountBase: '5' }
  const se = { chain: 'solana-mainnet', identity: SOLSIG, assetId: 'KEVIN', height: 10, blockHash: SOLSIG, amountBase: '5' }
  const s = (p) => src({ providerId: p, chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { ...se } } })
  const r = evaluate([sa], [s('pA'), s('pB')], pol); assert.equal(r.status, 'ok')
})
