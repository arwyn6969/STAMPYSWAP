'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { fixture, op, owner } = require('./audit-e.fixture.cjs')
const claims = require('../claims-report')
const U = 10n ** 18n
const base = value => (BigInt(value) * U).toString()
function event(f, key, delta, rep = 1) { f.db.prepare('INSERT INTO accounting_events(event_key,rep_id,delta_base) VALUES(?,?,?)').run(key, rep, String(delta)) }
function operation(f, key, amount = '10', chain = 'base', state = 'reserved') {
  f.db.prepare('INSERT INTO operations(op_key,action,canonical_id,amount,chain,state) VALUES(?,\'mint\',1,?,?,?)').run(key, amount, chain, state)
}
function ledger(f, { id = 1, direction = 'deposit', amount = '10', txid = 'deposit', chain = null, burn = null, status = 'confirmed' } = {}) {
  f.db.prepare('INSERT INTO collateral_ledger(id,canonical_id,direction,amount,btc_txid,dest_chain,burn_txid,status) VALUES(?,1,?,?,?,?,?,?)').run(id, direction, amount, txid, chain, burn, status)
}
function burn(f, txid, purpose, amount = '10') {
  f.db.prepare('INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,\'base\',1,?,?)').run(txid, purpose, amount)
}
async function report(f) { const response = await f.call('/api/claims', undefined, op); assert.equal(response.code, 200); return response.body }
const asset = report => report.assets.find(item => item.canonical_id === 1)
const hasGap = (a, code) => a.findings.some(item => item.code === code)

test('operator report uses one SELECT snapshot and does not access chains, signers or writes', async t => {
  let snapshots = 0
  const f = await fixture(t, { collateral: '0', circulating: '0', beforeQuery(sql) { if (sql === claims.SNAPSHOT_SQL) snapshots++ } })
  assert.equal((await f.call('/api/claims')).code, 403)
  assert.equal(snapshots, 0)
  assert.equal((await f.call('/api/claims?asset=COIN', undefined, op)).code, 400)
  assert.equal(snapshots, 0)
  const before = f.db.prepare('SELECT total_changes() n').get().n
  const r = await report(f)
  assert.equal(snapshots, 1)
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before)
  assert.equal(r.chain_reconciled, false); assert.equal(r.release_ready, false)
  assert.equal(r.full_customer_claims_verified, false); assert.equal(r.full_customer_claims_base, null)
  assert.equal(asset(r).observed_spendable_collateral_base, null)
  assert.equal(asset(r).chains.length, 6)
  assert.equal(f.state.mints.length + f.state.releases.length, 0)
})
test('deposit/reservation/event partition remains exact and retains rounding residue', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  ledger(f, { amount: '10.00000001' }); operation(f, 'deposit-mint:deposit')
  let a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, '0')
  assert.equal(a.buckets.issuance_reserved_without_event_base, base(10))
  assert.equal(a.buckets.matched_deposit_residual_base, '10000000000')
  assert.equal(a.buckets.accepted_deposit_awaiting_delivery_base, '10000000010000000000')
  event(f, 'mint:deposit-mint:deposit', base(10))
  a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, base(10))
  assert.equal(a.buckets.issuance_reserved_without_event_base, '0')
  assert.equal(a.buckets.accepted_deposit_awaiting_delivery_base, '10000000000')
  assert.equal(a.buckets.matched_deposit_residual_base, '10000000000')
  assert.equal(hasGap(a, 'deposit_rounding_residual_owner_and_disposition_unrecorded'), true)
})
test('one snapshot cannot omit a reservation that materializes while the response is returned', async t => {
  let transition = false, db
  const f = await fixture(t, { collateral: '0', circulating: '0', afterQuery(sql) {
    if (sql === claims.SNAPSHOT_SQL && transition) {
      transition = false
      db.prepare('INSERT INTO accounting_events(event_key,rep_id,delta_base) VALUES(?,1,?)').run('mint:deposit-mint:deposit', base(10))
      db.prepare("UPDATE operations SET state='completed' WHERE op_key='deposit-mint:deposit'").run()
    }
  } })
  db = f.db; ledger(f); operation(f, 'deposit-mint:deposit'); transition = true
  const first = asset(await report(f)), second = asset(await report(f))
  assert.equal(first.buckets.issuance_reserved_without_event_base, base(10)); assert.equal(first.buckets.circulating_event_base, '0')
  assert.equal(second.buckets.issuance_reserved_without_event_base, '0'); assert.equal(second.buckets.circulating_event_base, base(10))
})
test('move entitlement transfers between circulation, residual and reservation without double-counting', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  event(f, 'baseline:1', base(10)); event(f, 'move-out:burn:1', -10n * U)
  ledger(f, { direction: 'move-out', txid: 'burn', chain: 'base', status: 'decremented' }); burn(f, 'burn', 'move')
  let a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, '0')
  assert.equal(a.buckets.debited_move_unreserved_remainder_base, base(10))
  assert.equal(hasGap(a, 'debited_move_destination_intent_unrecorded'), true)
  operation(f, 'move-mint:burn', '10', 'ethereum')
  a = asset(await report(f))
  assert.equal(a.buckets.debited_move_unreserved_remainder_base, '0')
  assert.equal(a.buckets.issuance_reserved_without_event_base, base(10))
  f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain) VALUES(2,1,'ethereum')").run()
  event(f, 'mint:move-mint:burn', base(10), 2)
  a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, base(10))
  assert.equal(a.buckets.issuance_reserved_without_event_base, '0')
  assert.equal(a.buckets.recorded_move_awaiting_delivery_base, '0')
})
test('phase-only move marker is exposed as an unverified debit, not a fulfilled claim', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '10' })
  ledger(f, { direction: 'move-out', txid: 'burn', chain: 'base', status: 'decremented' }); burn(f, 'burn', 'move')
  const a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, base(10)); assert.equal(a.buckets.debited_move_unreserved_remainder_base, '0')
  assert.equal(a.buckets.recorded_move_awaiting_delivery_base, base(10))
  assert.equal(hasGap(a, 'move_burn_not_reflected_by_exact_source_debit'), true)
})
test('released status and supplied txid do not prove the burned customer was paid', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '20' })
  ledger(f, { direction: 'redeem', txid: null, chain: 'base', burn: 'burn', status: 'pending' }); burn(f, 'burn', 'redeem')
  let a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, base(20))
  assert.equal(a.buckets.pending_redeem_included_in_circulation_base, base(10))
  assert.equal(a.buckets.potential_unpaid_redeem_after_debit_base, '0')
  event(f, 'release:1', -10n * U)
  f.db.prepare("UPDATE collateral_ledger SET status='released',btc_txid='unverified-tx' WHERE id=1").run()
  a = asset(await report(f))
  assert.equal(a.buckets.circulating_event_base, base(10))
  assert.equal(a.buckets.pending_redeem_included_in_circulation_base, '0')
  assert.equal(a.buckets.potential_unpaid_redeem_after_debit_base, base(10))
  assert.equal(hasGap(a, 'redeem_recipient_and_canonical_protocol_payout_proof_unrecorded'), true)
  assert.equal(a.full_customer_claims_base, null)
})
test('legacy deposits, orphan burns and stamp bridge claims remain explicitly unallocated', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '10' })
  ledger(f, { txid: 'legacy' }); burn(f, 'orphan', 'redeem', null)
  f.db.prepare("INSERT INTO bridge_ops(id,src20_tick,stamp_asset,amount,burn_txid,status) VALUES(1,'COIN','STAMP','2','stamp-burn','released')").run()
  const r = await report(f), a = asset(r)
  assert.equal(a.buckets.circulating_event_base, base(10)); assert.equal(a.buckets.unallocated_accepted_deposit_base, base(10))
  assert.equal(a.classification_complete, false)
  assert.equal(hasGap(a, 'accepted_deposit_delivery_or_legacy_overlap_unverified'), true)
  assert.equal(hasGap(a, 'orphan_or_unclassified_consumed_burn'), true)
  assert.equal(r.unallocated_stamp_bridge_claims[0].canonical_id, null)
  assert.equal(r.unallocated_stamp_bridge_claims[0].customer_paid_verified, false)
})
test('completed operation without event remains potential unaccounted issuance', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  operation(f, 'direct', '10', 'base-mainnet', 'completed')
  const a = asset(await report(f))
  assert.equal(a.buckets.completed_issuance_missing_event_base, base(10))
  assert.equal(hasGap(a, 'completed_mint_missing_accounting_event'), true)
})
test('all assets and mainnet/historical chains use exact integers beyond Number precision', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  const amount = '9007199254740993.00000001', delta = 9007199254740993000000010000000000n
  ledger(f, { amount }); operation(f, 'deposit-mint:deposit', amount, 'ethereum-mainnet')
  f.db.prepare("INSERT INTO canonical_assets(id,exact_ticker,source_protocol,decimals,max_supply) VALUES(2,'COIN','acme',0,'100')").run()
  const r = await report(f)
  assert.equal(r.assets.length, 2)
  assert.equal(asset(r).buckets.issuance_reserved_without_event_base, delta.toString())
  assert.equal(asset(r).chains.find(item => item.chain === 'ethereum-mainnet').issuance_reserved_without_event_base, delta.toString())
  assert.equal(r.assets[1].source_protocol, 'acme')
})
for (const target of ['ledger', 'operation', 'event']) test('malformed ' + target + ' quantity refuses the whole report without zeros', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  if (target === 'ledger') ledger(f, { amount: '1e3' })
  if (target === 'operation') operation(f, 'bad', '-1')
  if (target === 'event') event(f, 'bad', '1.2')
  const r = await f.call('/api/claims', undefined, op)
  assert.equal(r.code, 503); assert.equal(r.body.accounting_snapshot_complete, false)
  assert.equal(Object.hasOwn(r.body, 'assets'), false); assert.equal(r.body.full_customer_claims_base, null)
})
test('database errors cannot become empty liabilities or expose credentials', async t => {
  const f = await fixture(t, { beforeQuery(sql) { if (sql === claims.SNAPSHOT_SQL) throw Error('https://paid.invalid/SECRET') } })
  const r = await f.call('/api/claims', undefined, op)
  assert.equal(r.code, 503); assert.equal(JSON.stringify(r.body).includes('SECRET'), false)
  assert.equal(Object.hasOwn(r.body, 'assets'), false)
})
test('same-snapshot table counts detect truncated or omitted rows even when the JSON is valid', async t => {
  const f = await fixture(t, { collateral: '0', circulating: '0' })
  ledger(f); operation(f, 'deposit-mint:deposit')
  const rows = f.db.prepare(claims.SNAPSHOT_SQL).all(claims.MAX_ROWS + 2)
  assert.equal(claims.buildClaimsReport(rows).record_counts.operations, 1)
  assert.throws(() => claims.buildClaimsReport(rows.slice(0, -1)), /invalid accounting evidence/)
  assert.throws(() => claims.buildClaimsReport(rows.filter(row => row.table_name !== 'operations')), /invalid accounting evidence/)
  assert.throws(() => claims.buildClaimsReport(rows.slice(1)), /invalid accounting evidence/)
})
test('dirty-read mode refuses the report instead of claiming a coherent snapshot', async t => {
  const f = await fixture(t)
  f.db.exec('PRAGMA read_uncommitted=1')
  assert.equal((await f.call('/api/claims', undefined, op)).code, 503)
})
test('malformed snapshots, unknown relations and fixed whole-report limits fail closed', async () => {
  const row = { table_name: 'canonical_assets', record_json: JSON.stringify({ id: 1, exact_ticker: 'COIN', source_protocol: 'src-20', decimals: 8, max_supply: '100' }) }
  const withMeta = rows => [{ table_name: 'snapshot_meta', record_json: JSON.stringify({ read_uncommitted: 0, ...Object.fromEntries(['canonical_assets', 'representations', 'accounting_events', 'operations', 'collateral_ledger', 'consumed_burns', 'bridge_ops'].map(table => [table, rows.filter(item => item.table_name === table).length])) }) }, ...rows]
  for (const snapshot of [{}, [null], withMeta([{ ...row, record_json: '{}' }]), withMeta([{ ...row, table_name: 'unexpected' }]), withMeta(Array(claims.MAX_ROWS + 1).fill(row)),
    withMeta(Array.from({ length: claims.MAX_ASSETS + 1 }, (_, i) => ({ ...row, record_json: JSON.stringify({ ...JSON.parse(row.record_json), id: i + 1 }) })))])
    assert.throws(() => claims.buildClaimsReport(snapshot), /invalid accounting evidence/)
  await assert.rejects(claims.readClaimsReport(async () => { throw Error('query unavailable') }), /query unavailable/)
})
test('negative authoritative representation balance refuses mint, reserves and claims', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '0' })
  event(f, 'negative', -1n)
  const minted = await f.call('/api/mint', { tick: 'COIN', amount: '10', chain: 'base', receive_address: owner.address, op_key: 'negative-mint' }, op)
  assert.equal(minted.code, 503); assert.equal(f.state.mints.length, 0)
  const reserves = await f.call('/api/reserves')
  assert.equal(reserves.code, 500); assert.equal(Object.hasOwn(reserves.body, 'assets'), false)
  assert.equal((await f.call('/api/claims', undefined, op)).code, 503)
  await assert.rejects(vm.runInContext('repCirculatingBase(1)', f.context), /negative authoritative/)
})
test('a positive peer representation cannot hide a negative representation balance', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '0' })
  f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain) VALUES(2,1,'ethereum')").run()
  event(f, 'negative', -1n); event(f, 'positive', 10n * U, 2)
  await assert.rejects(vm.runInContext('assetCirculatingBase(1)', f.context), /negative authoritative/)
  assert.equal((await f.call('/api/claims', undefined, op)).code, 503)
})
test('an overdrawn accounting debit never reports success or materializes a zero cache', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '5' })
  await assert.rejects(vm.runInContext("applyCirculatingDelta(1, -10n * 10n**18n, 'overdrawn-debit')", f.context), /negative authoritative/)
  assert.equal(f.circ(), '5')
  assert.equal((await f.call('/api/claims', undefined, op)).code, 503)
  assert.equal(f.state.mints.length + f.state.releases.length, 0)
})
