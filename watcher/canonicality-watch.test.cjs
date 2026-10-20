'use strict'
const test = require('node:test'); const assert = require('node:assert')
const W = require('./canonicality-watch.cjs'); const { evaluate, formOk, eqForm, b58encode, b58canonical } = W
const buf = (n, f) => Uint8Array.from(new Array(n).fill(f))
const SHASH = b58encode(buf(32, 7)), SHASH2 = b58encode(buf(32, 8)), SSIG = b58encode(buf(64, 9)), SSIG2 = b58encode(buf(64, 11))
const HX = '0x' + 'a'.repeat(64), HB = '0x' + 'b'.repeat(64), HB2 = '0x' + 'c'.repeat(64)
const M = { kind: 'burn', chain: 'base-mainnet', identity: HX, assetId: 'ACME', height: 50, blockHash: HB, amountBase: '1000' }
const POL = () => ({ version: 1, minIndependentSources: 2, now: 10000, maxObsAgeMs: 5000,
  chains: { 'base-mainnet': { networkId: 8453, protocolVersion: 1, idForm: 'evm', hashForm: 'evm', minConfirmations: 3 },
            'solana-mainnet': { networkId: 'sol', protocolVersion: 1, idForm: 'sol-sig', hashForm: 'sol-hash' } },
  trustedProviders: { pA: { operatorGroup: 'gA', chains: ['base-mainnet', 'solana-mainnet'] },
                      pA2: { operatorGroup: 'gA', chains: ['base-mainnet'] },
                      pB: { operatorGroup: 'gB', chains: ['base-mainnet', 'solana-mainnet'] },
                      pC: { operatorGroup: 'gC', chains: ['base-mainnet'] } },
  expectedAnchors: { e1: { ...M } } })
const A = { effect_id: 'e1', ...M }
const src = (over) => Object.assign({ providerId: 'pA', chain: 'base-mainnet', networkId: 8453, protocolVersion: 1,
  historyComplete: true, paginationComplete: true, tipHeight: 100, finalizedHeight: 100, observedAt: 9000, effects: { e1: { ...M } } }, over)
const has = (r, c) => r.reasons.includes(c)

test('happy evm: 2 groups agree -> ok', () => assert.equal(evaluate([A], [src(), src({ providerId: 'pB' })], POL()).status, 'ok'))

// DEFECT 1 — base58 case sensitivity
test('b58 is case-sensitive + hex is not (unit)', () => {
  assert.equal(eqForm('evm', HX.toUpperCase(), HX), true)   // hex case-insensitive
  assert.equal(eqForm('sol-hash', SHASH, SHASH), true)
  assert.equal(eqForm('sol-hash', SHASH, SHASH2), false)    // distinct bytes -> not equal
})
test('solana: source blockhash with different bytes -> disagreement pause (no lowercasing)', () => {
  const p = POL(); p.expectedAnchors = { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' } }
  const good = (pr) => src({ providerId: pr, chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' } } })
  const bad = src({ providerId: 'pB', chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH2, amountBase: '5' } } })
  const r = evaluate([{ effect_id: 's1', kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' }], [good('pA'), bad], p)
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:trusted_source_disagreement'))
})
// DEFECT 2 — decode length, not regex
test('b58 length enforced by decode', () => {
  assert.equal(formOk('sol-hash', SHASH), true); assert.equal(formOk('sol-sig', SSIG), true)
  assert.equal(formOk('sol-hash', '1'.repeat(44)), false)  // 44 zero-bytes != 32
  assert.equal(formOk('sol-sig', '1'.repeat(88)), false)   // 88 zero-bytes != 64
  assert.equal(formOk('sol-hash', SSIG), false)            // 64 bytes not a 32-byte hash
  assert.equal(b58canonical('0OIl', 32), false)            // invalid base58 chars
})
// DEFECT 3 — no JSON.stringify crash on bigint/cyclic; pause not throw
test('bigint/cyclic anchor fields pause, never throw', () => {
  const big = { effect_id: 'e1', ...M, amountBase: 1000n }
  const cyc = { effect_id: 'e1', ...M }; cyc.self = cyc
  assert.doesNotThrow(() => { const r = evaluate([big], [src(), src({ providerId: 'pB' })], POL()); assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:supplied_anchor_mismatch')) })
  assert.doesNotThrow(() => evaluate([cyc], [src(), src({ providerId: 'pB' })], POL()))
})
// DEFECT 4 — order-independent contradiction (first-wins must not hide a conflict)
for (const order of ['conflict-last', 'conflict-first']) test('order invariance: a conflicting same-group source pauses (' + order + ')', () => {
  const good1 = src({ providerId: 'pA' }), good2 = src({ providerId: 'pB' })
  const conflict = src({ providerId: 'pA2', effects: { e1: { ...M, blockHash: HB2 } } }) // gA, disagrees
  const list = order === 'conflict-first' ? [conflict, good1, good2] : [good1, good2, conflict]
  const r = evaluate([A], list, POL()); assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:trusted_source_disagreement'))
})
test('no conflict -> ok (control for order test)', () => assert.equal(evaluate([A], [src({ providerId: 'pA' }), src({ providerId: 'pB' })], POL()).status, 'ok'))
// DEFECT 5 — qualified completeness-complete source that OMITS the effect = disagreement
test('healthy same-chain source with effects:{} -> disagreement pause', () => {
  const r = evaluate([A], [src(), src({ providerId: 'pB' }), src({ providerId: 'pC', effects: {} })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:trusted_source_disagreement'))
})
// DEFECT 6 — bounded, scalar, versioned policy (throws)
test('too many expectedAnchors throws', () => { const p = POL(); p.expectedAnchors = {}; for (let i = 0; i < 300; i++) p.expectedAnchors['e' + i] = { ...M }; assert.throws(() => evaluate([A], [src()], p)) })
test('empty networkId throws', () => { const p = POL(); p.chains['base-mainnet'].networkId = ''; assert.throws(() => evaluate([A], [src()], p)) })
test('boolean protocolVersion throws', () => { const p = POL(); p.chains['base-mainnet'].protocolVersion = false; assert.throws(() => evaluate([A], [src()], p)) })
test('array chain config throws', () => { const p = POL(); p.chains['base-mainnet'] = []; assert.throws(() => evaluate([A], [src()], p)) })
test('minIndependentSources < 2 throws', () => assert.throws(() => evaluate([A], [src()], Object.assign(POL(), { minIndependentSources: 1 }))))
test('version != 1 throws', () => assert.throws(() => evaluate([A], [src()], Object.assign(POL(), { version: 2 }))))
// DEFECT 7 — content pinned by policy, not just label
test('supplied anchor content != manifest -> supplied_anchor_mismatch', () => {
  const r = evaluate([{ ...A, amountBase: '999' }], [src(), src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'anchor:supplied_anchor_mismatch')) })
test('unexpected anchor (label not in manifest) -> unexpected_anchor', () => {
  const r = evaluate([A, { ...A, effect_id: 'eX' }], [src(), src({ providerId: 'pB' })], POL())
  assert.equal(r.status, 'pause'); assert.ok(has(r, 'unexpected_anchor')) })
test('missing expected anchor -> pause', () => { const r = evaluate([], [src(), src({ providerId: 'pB' })], POL()); assert.ok(has(r, 'anchor:missing_expected_anchor')) })
// misc hardening retained
test('__proto__ providerId -> untrusted (own-prop)', () => { const r = evaluate([A], [src({ providerId: '__proto__' }), src({ providerId: 'pB' })], POL()); assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:untrusted_provider')) })
test('source.error excluded', () => { const r = evaluate([A], [src({ error: true }), src({ error: true, providerId: 'pB' })], POL()); assert.equal(r.status, 'pause'); assert.ok(has(r, 'source:read_error_or_missing')) })
test('solana valid full path -> ok', () => {
  const p = POL(); p.expectedAnchors = { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' } }
  const s = (pr) => src({ providerId: pr, chain: 'solana-mainnet', networkId: 'sol', finalizedHeight: 20, tipHeight: 20, effects: { s1: { kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' } } })
  assert.equal(evaluate([{ effect_id: 's1', kind: 'burn', chain: 'solana-mainnet', identity: SSIG, assetId: 'K', height: 10, blockHash: SHASH, amountBase: '5' }], [s('pA'), s('pB')], p).status, 'ok') })
