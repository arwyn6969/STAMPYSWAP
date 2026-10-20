'use strict'
const test = require('node:test'); const assert = require('node:assert')
const { evaluate } = require('./canonicality-watch.cjs')
const HX = '0x' + 'a'.repeat(64), HB = '0x' + 'b'.repeat(64)
const SSIG = '5'.repeat(88), SHASH = '5'.repeat(44)
const POL = () => ({ version: 1, minIndependentSources: 2, now: 10000, maxObsAgeMs: 5000,
  chains: { 'base-mainnet': { networkId: 8453, protocolVersion: 1, idForm: 'evm', hashForm: 'evm', minConfirmations: 3 },
            'bitcoin-mainnet': { networkId: 'btc', protocolVersion: 1, idForm: 'btc', hashForm: 'btc' },
            'solana-mainnet': { networkId: 'sol', protocolVersion: 1, idForm: 'sol-sig', hashForm: 'sol-hash' } },
  trustedProviders: { pA: { operatorGroup: 'gA', chains: ['base-mainnet', 'solana-mainnet'] },
                      pB: { operatorGroup: 'gB', chains: ['base-mainnet', 'solana-mainnet'] },
                      pC: { operatorGroup: 'gC', chains: ['base-mainnet'] } },
  expectedEffectIds: ['e1'] })
const eff = { kind: 'burn', chain: 'base-mainnet', identity: HX, assetId: 'ACME', height: 50, blockHash: HB, amountBase: '1000' }
const A = Object.assign({ effect_id: 'e1' }, eff)
const src = (over) => Object.assign({ providerId: 'pA', chain: 'base-mainnet', networkId: 8453, protocolVersion: 1,
  historyComplete: true, paginationComplete: true, tipHeight: 100, finalizedHeight: 100, observedAt: 9000,
  effects: { e1: { ...eff } } }, over)
const two = () => [src(), src({ providerId: 'pB' })]
const has = (r, code) => r.reasons.includes(code)

test('happy evm: 2 operator groups exact+final -> ok', () => { const r = evaluate([A], two(), POL()); assert.equal(r.status, 'ok') })

// 1-2 prototype pollution
test('__proto__ providerId -> untrusted (own-prop only)', () => {
  const r = evaluate([A], [src({ providerId: '__proto__' }), src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:untrusted_provider')) })
test('__proto__ chain -> unknown_chain', () => {
  const r = evaluate([A], [src({ chain: '__proto__' }), src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:unknown_chain')) })
// 3 error ignored
test('source.error=true with cached data -> excluded -> pause', () => {
  const r = evaluate([A], [src({ error: true }), src({ error: true, providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:read_error_or_missing')) })
// 4 cross-chain effect
test('bitcoin source carrying a base effect does NOT count toward base quorum', () => {
  const btc = src({ providerId: 'pA', chain: 'bitcoin-mainnet', networkId: 'btc', effects: { e1: { ...eff } } }) // base effect on a btc source
  const r = evaluate([A], [btc, src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause') }) // only 1 real base match
// 5 impossible heights
test('finalized>tip -> impossible_finality', () => {
  const r = evaluate([A], [src({ finalizedHeight: 100, tipHeight: 1 }), src({ providerId: 'pB', finalizedHeight: 100, tipHeight: 1 })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:impossible_finality')) })
test('anchor height > finalized -> no match', () => {
  const r = evaluate([{ ...A, height: 200 }], two().map(s => ({ ...s, effects: { e1: { ...eff, height: 200 } } })), POL())
  assert.equal(r.status, 'pause') })
// 6 numeric amount
test('numeric anchor amount -> bad_amount_precision (no String coercion)', () => {
  const r = evaluate([{ ...A, amountBase: 1000 }], two(), POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:bad_amount_precision')) })
// 7 solana sig vs hash
test('solana: 32-byte value used as tx identity -> bad_tx_identity', () => {
  const p = POL(); p.expectedEffectIds = ['s1']
  const sa = { effect_id: 's1', kind: 'burn', chain: 'solana-mainnet', identity: SHASH, assetId: 'KEVIN', height: 10, blockHash: SHASH, amountBase: '5' } // identity too short for a sig
  const ss = (pr) => src({ providerId: pr, chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SHASH, assetId: 'KEVIN', height: 10, blockHash: SHASH, amountBase: '5' } } })
  const r = evaluate([sa], [ss('pA'), ss('pB')], p); assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:bad_tx_identity')) })
test('solana valid sig+hash -> ok', () => {
  const p = POL(); p.expectedEffectIds = ['s1']
  const e = { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'KEVIN', height: 10, blockHash: SHASH, amountBase: '5' }
  const sa = { effect_id: 's1', ...e }
  const ss = (pr) => src({ providerId: pr, chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { ...e } } })
  const r = evaluate([sa], [ss('pA'), ss('pB')], p); assert.equal(r.status, 'ok') })
// 8 missing kind
test('missing kind on anchor -> missing_kind', () => {
  const r = evaluate([{ ...A, kind: undefined }], two(), POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:missing_kind')) })
test('kind mismatch in observation -> disagreement', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB', effects: { e1: { ...eff, kind: 'mint' } } })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:trusted_source_disagreement')) })
// 9-10 policy validation throws
test('version != 1 throws', () => assert.throws(() => evaluate([A], two(), Object.assign(POL(), { version: 2 }))))
test('duplicate expectedEffectIds throws', () => assert.throws(() => evaluate([A], two(), Object.assign(POL(), { expectedEffectIds: ['e1', 'e1'] }))))
test('non-string expectedEffectId throws', () => assert.throws(() => evaluate([A], two(), Object.assign(POL(), { expectedEffectIds: [123] }))))
test('provider authorizes unknown chain throws', () => { const p = POL(); p.trustedProviders.pA.chains = ['nope']; assert.throws(() => evaluate([A], two(), p)) })
// 11 unexpected anchor
test('extra anchor not in inventory -> unexpected_anchor', () => {
  const r = evaluate([A, { ...A, effect_id: 'eX' }], two(), POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'unexpected_anchor')) })
// 12 malformed must pause not crash
test('null/garbage entries in anchors+sources -> pause, no crash', () => {
  const r = evaluate([null, 42, A], [null, 'x', src(), src({ providerId: 'pB' })], POL())
  assert.ok(['ok', 'pause'].includes(r.status)); assert.ok(has(r, 'source:malformed_observation') || has(r, 'malformed_anchor_id')) })
// 13 disagreement after quorum
test('2 match + 1 disagreeing hash -> pause despite quorum', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB' }), src({ providerId: 'pC', effects: { e1: { ...eff, blockHash: '0x' + 'c'.repeat(64) } } })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:trusted_source_disagreement')) })
// 14 provider not authorized for chain
test('provider authorized only for base, claims solana -> provider_not_authorized_for_chain', () => {
  const p = POL(); p.expectedEffectIds = ['s1']
  const e = { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'KEVIN', height: 10, blockHash: SHASH, amountBase: '5' }
  const sa = { effect_id: 's1', ...e }
  const bad = src({ providerId: 'pC', chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { ...e } } }) // pC not authorized for solana
  const good = src({ providerId: 'pA', chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { ...e } } })
  const r = evaluate([sa], [bad, good], p); assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:provider_not_authorized_for_chain')) })
// 15 valid multi-chain not globally rejected
test('base anchor OK even with an unrelated healthy solana source present', () => {
  const sol = src({ providerId: 'pA', chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: {} })
  const r = evaluate([A], [src({ providerId: 'pB' }), src({ providerId: 'pC' }), sol], POL()) // 2 base groups gB,gC + a solana source
  assert.equal(r.status, 'ok') })
// 16 confirmations depth
test('below minConfirmations -> no match', () => {
  const r = evaluate([{ ...A, height: 99 }], two().map(s => ({ ...s, effects: { e1: { ...eff, height: 99 } } })), POL()) // 100-99+1=2 < 3
  assert.equal(r.status, 'pause') })
