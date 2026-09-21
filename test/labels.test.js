// Prevention tests for on-chain provenance labels (audit: canonical cross-protocol identity).
// Pure logic → `node --test`, no server/DB.
const test = require('node:test')
const assert = require('node:assert')
const { srcOriginFor } = require('../labels')

test('SRC-20 provenance anchors on the deploy tx', () => {
  assert.strictEqual(
    srcOriginFor({ source_protocol: 'src-20', exact_ticker: 'KEVIN', deploy_tx: '23765f9b' }),
    'bitcoin:src-20:KEVIN:23765f9b')
})

test('ACME provenance names the ACME protocol (no deploy tx, no double-prefix)', () => {
  assert.strictEqual(
    srcOriginFor({ source_protocol: 'acme', exact_ticker: 'TREES', deploy_tx: 'acme:TREES' }),
    'bitcoin:acme:TREES')
})

test('Counterparty provenance names counterparty (not src-20)', () => {
  assert.strictEqual(
    srcOriginFor({ source_protocol: 'counterparty', exact_ticker: 'PUDSEC', deploy_tx: 'counterparty:PUDSEC' }),
    'bitcoin:counterparty:PUDSEC')
})

test('missing protocol defaults to src-20 (back-compat)', () => {
  assert.strictEqual(
    srcOriginFor({ exact_ticker: 'FOO', deploy_tx: 'abc' }),
    'bitcoin:src-20:FOO:abc')
  // never throws on a null/empty asset
  assert.strictEqual(srcOriginFor(null), 'bitcoin:src-20::')
})
