'use strict'
// Fake paid-provider credentials only; real routing with mocked chain/custody effects.
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, owner, op } = require('./audit-e.fixture.cjs')
const endpoint = 'https://rpc.invalid/private-key?api-key=fixture-token'
const failure = code => Object.assign(new Error('upstream request failed: ' + endpoint + ' Authorization: Bearer fixture-token'), { code: code || 'SERVER_ERROR' })
const noSecrets = result => assert(!/rpc\.invalid|private-key|api-key|fixture-token|Authorization|Bearer/.test(JSON.stringify(result)), JSON.stringify(result))
const mint = key => ({ tick: 'COIN', amount: '10', chain: 'base', receive_address: owner.address, op_key: key })

test('public authority exceptions use fixed service errors, never upstream messages or codes', async t => {
  const f = await fixture(t)
  f.sol.authorityInfo = async () => { throw failure('fixture-token') }
  const r = await f.call('/api/mint/authority')
  assert.equal(r.code, 500)
  assert.equal(r.body.code, 'SERVICE_UNAVAILABLE')
  assert.match(r.body.error, /service temporarily unavailable/)
  noSecrets(r)
})
test('public status removes endpoint/config/debug fields and returned-error data', async t => {
  const f = await fixture(t)
  f.custody.status = async () => ({ provider: 'none', live: false, error: failure().message,
    rpc: endpoint, endpoint, debug: { token: 'fixture-token' }, note: failure().message })
  f.sol.authorityInfo = async () => ({ address: 'public-authority', network: 'devnet', rpc_configured: true, rpc: endpoint,
    code: 'INDEPENDENT_SIGNING_REQUIRED', details: failure().message })
  for (const route of ['/api/custody/status', '/api/trust', '/api/mint/authority']) {
    const r = await f.call(route)
    assert.equal(r.code, 200)
    noSecrets(r)
    if (route === '/api/mint/authority') {
      assert.equal(r.body.rpc_configured, true)
      assert.equal(r.body.code, 'INDEPENDENT_SIGNING_REQUIRED')
      assert.equal(Object.hasOwn(r.body, 'rpc'), false)
    }
  }
})
test('unexpected database read failures keep status and omit provider details', async t => {
  let active = false
  const f = await fixture(t, { beforeQuery: async () => { if (active) throw failure() } })
  active = true
  const r = await f.call('/api/reserves')
  assert.equal(r.code, 500)
  assert.equal(r.body.code, 'SERVICE_UNAVAILABLE')
  noSecrets(r)
})
test('uncertain mint failures hide paid endpoints while retaining reservations/reconcile semantics', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '0' })
  f.evm.deployAndMint = async () => { throw failure() }
  const r = await f.call('/api/mint', mint('paid-rpc-mint'), op)
  assert.equal(r.code, 502)
  assert.equal(r.body.reconcile, true)
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='paid-rpc-mint'").get().state, 'reconcile')
  noSecrets(r)
})
test('known funding failures retain safe codes but reject credential-shaped funding metadata', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '0' })
  f.evm.deployAndMint = async () => { throw Object.assign(failure('UNFUNDED'), { authority: endpoint }) }
  const r = await f.call('/api/mint', mint('unfunded-rpc-mint'), op)
  assert.equal(r.code, 503)
  assert.equal(r.body.code, 'UNFUNDED')
  assert.equal(r.body.needs_funding, null)
  assert.equal(f.db.prepare("SELECT * FROM operations WHERE op_key='unfunded-rpc-mint'").get(), undefined)
  noSecrets(r)
})
test('uncertain custody failures hide paid endpoints while retaining the consumed burn', async t => {
  const f = await fixture(t)
  f.custody.redeem = async () => { throw failure() }
  const r = await f.call('/api/custody/redeem', await f.redeem(), op)
  assert.equal(r.code, 502)
  assert.equal(r.body.reconcile, true)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1)
  assert.equal(f.db.prepare("SELECT status FROM collateral_ledger WHERE direction='redeem'").get().status, 'reconcile')
  noSecrets(r)
})
test('burn adapter exception-as-data cannot leak through financial validation reasons', async t => {
  const f = await fixture(t)
  f.evm.verifyBurn = async () => ({ valid: false, reason: failure().message, code: 'fixture-token' })
  const r = await f.call('/api/custody/redeem', await f.redeem(), op)
  assert.equal(r.code, 409)
  assert.match(r.body.reason, /verification unavailable or invalid/)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
  noSecrets(r)
})
test('explicit request and burn-finality validation messages remain useful', async t => {
  const f = await fixture(t)
  const invalid = await f.call('/api/mint', { ...mint('invalid'), amount: 'NaN' }, op)
  assert.equal(invalid.code, 400)
  assert.match(invalid.body.error, /amount must be a positive number/)
  f.evm.verifyBurn = async () => ({ valid: false, reason: 'burn block is not finalized' })
  const r = await f.call('/api/custody/redeem', await f.redeem(), op)
  assert.equal(r.code, 409)
  assert.equal(r.body.reason, 'burn block is not finalized')
})
test('per-item authority migration failures also hide upstream diagnostics', async t => {
  const f = await fixture(t)
  f.db.prepare("UPDATE representations SET dest_chain='solana' WHERE id=1").run()
  f.sol.migrateAuthority = async () => { throw failure() }
  const r = await f.call('/api/mint/migrate-authority', { target: 'emblem' }, op)
  assert.equal(r.code, 200)
  assert.equal(r.body.migrated.length, 1)
  assert.equal(r.body.migrated[0].code, 'SERVICE_UNAVAILABLE')
  noSecrets(r)
})
test('oversized public status fails closed instead of leaking diagnostics or partial readiness', async t => {
  const f = await fixture(t)
  f.sol.authorityInfo = async () => ({ signing_available: true, members: Array(129).fill('member'), error: failure().message })
  const r = await f.call('/api/mint/authority')
  assert.equal(r.code, 200)
  assert.equal(r.body.signing_available, false)
  assert.equal(r.body.available, false)
  noSecrets(r)
})
