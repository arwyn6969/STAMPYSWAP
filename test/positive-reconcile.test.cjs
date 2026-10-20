'use strict'
// Real handler/SQLite recovery tests, with fixed fixture signatures and mocked chains.
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, burnId, op } = require('./audit-e.fixture.cjs')
const request = { kind: 'move', burn_txid: burnId, resolution: 'decremented' }
const moveRow = f => f.db.prepare("SELECT * FROM collateral_ledger WHERE direction='move-out'").get()
const debit = f => f.db.prepare("SELECT * FROM accounting_events WHERE event_key LIKE 'move-out:%'").get()

test('positive move reconciliation refuses a missing source debit instead of trusting the operator', async t => {
  let failDebit = true
  const f = await fixture(t, { beforeExec: async (sql, params) => {
    if (failDebit && sql.startsWith('INSERT INTO accounting_events') && params[0].startsWith('move-out:')) throw Error('fixture debit never committed')
  } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  assert.equal(moveRow(f).status, 'pending')
  assert.equal(debit(f), undefined)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1)
  failDebit = false
  const recovered = await f.call('/api/reconcile', request, op)
  assert.equal(recovered.code, 409, 'missing event is not independently established source debit')
  assert.equal(moveRow(f).status, 'pending')
  assert.equal(debit(f), undefined)
  assert.equal(f.circ(), '100')
  assert.equal(f.state.mints.length, 0)
})

test('positive move reconciliation preserves pending when cache rematerialization fails', async t => {
  const f = await fixture(t, { beforeExec: async sql => {
    if (sql.startsWith('UPDATE representations SET circulating_supply')) throw Error('fixture materialization write unavailable')
  } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  assert.equal(moveRow(f).status, 'pending')
  const expectedDebit = debit(f)
  assert.equal(expectedDebit.delta_base, '-10000000000000000000')
  assert.equal(f.circ(), '100')
  const recovered = await f.call('/api/reconcile', request, op)
  assert([500, 503].includes(recovered.code), 'failed rematerialization must not become a successful phase transition')
  assert.equal(moveRow(f).status, 'pending')
  assert.deepEqual(debit(f), expectedDebit)
  assert.equal(f.circ(), '100')
  assert.equal(f.state.mints.length, 0)
})

test('positive move reconciliation can repair an exact committed debit without another mint or debit', async t => {
  let failPhase = true
  const f = await fixture(t, { beforeExec: async sql => {
    if (failPhase && sql.startsWith("UPDATE collateral_ledger SET status='decremented'")) throw Error('fixture phase acknowledgement lost')
  } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  const expectedDebit = debit(f)
  assert.equal(expectedDebit.delta_base, '-10000000000000000000')
  assert.equal(moveRow(f).status, 'pending')
  failPhase = false
  const recovered = await f.call('/api/reconcile', request, op)
  assert.equal(recovered.code, 200)
  assert.equal(moveRow(f).status, 'decremented')
  assert.deepEqual(debit(f), expectedDebit)
  assert.equal(f.circ(), '90')
  assert.equal(f.state.mints.length, 0)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1)
})

for (const mismatch of ['amount', 'representation']) {
  test('positive move reconciliation refuses a debit event with the wrong ' + mismatch, async t => {
    const f = await fixture(t, { beforeExec: async (sql, params) => {
      if (sql.startsWith('INSERT INTO accounting_events') && params[0].startsWith('move-out:')) throw Error('debit absent')
    } })
    assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
    if (mismatch === 'representation') f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply) VALUES(2,1,'ethereum','other','0')").run()
    f.db.prepare('INSERT INTO accounting_events(event_key,rep_id,delta_base,created_at) VALUES(?,?,?,1)')
      .run(`move-out:${burnId}:1`, mismatch === 'representation' ? 2 : 1, mismatch === 'amount' ? '-9000000000000000000' : '-10000000000000000000')
    assert.equal((await f.call('/api/reconcile', request, op)).code, 409)
    assert.equal(moveRow(f).status, 'pending')
    assert.equal(f.state.mints.length, 0)
  })
}

test('positive move reconciliation detects an acknowledged no-op phase update', async t => {
  let mode = 'throw'
  const f = await fixture(t, { beforeExec: async (sql, params) => {
    if (sql.startsWith("UPDATE collateral_ledger SET status='decremented'")) {
      if (mode === 'throw') throw Error('initial phase unavailable')
      if (mode === 'noop') params[0] = 99999
    }
  } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  mode = 'noop'
  assert([500, 503].includes((await f.call('/api/reconcile', request, op)).code))
  assert.equal(moveRow(f).status, 'pending')
  assert.equal(f.state.mints.length, 0)
})

test('positive move reconciliation verifies a phase committed before its acknowledgement was lost', async t => {
  let initial = true, loseAck = false
  const f = await fixture(t, {
    beforeExec: async sql => { if (initial && sql.startsWith("UPDATE collateral_ledger SET status='decremented'")) throw Error('initial phase unavailable') },
    afterExec: async sql => { if (loseAck && sql.startsWith("UPDATE collateral_ledger SET status='decremented'")) throw Error('phase committed; acknowledgement lost') }
  })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  const expectedDebit = debit(f)
  initial = false; loseAck = true
  assert.equal((await f.call('/api/reconcile', request, op)).code, 200)
  assert.equal(moveRow(f).status, 'decremented')
  assert.deepEqual(debit(f), expectedDebit)
  assert.equal(f.state.mints.length, 0)
})

test('positive move reconciliation detects an acknowledged no-op cache materialization', async t => {
  let initial = true
  const f = await fixture(t, { beforeExec: async (sql, params) => {
    if (initial && sql.startsWith("UPDATE collateral_ledger SET status='decremented'")) throw Error('initial phase unavailable')
    if (!initial && sql.startsWith('UPDATE representations SET circulating_supply')) params[2] = 99999
  } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500)
  f.db.prepare("UPDATE representations SET circulating_supply='100' WHERE id=1").run()
  initial = false
  assert([500, 503].includes((await f.call('/api/reconcile', request, op)).code))
  assert.equal(moveRow(f).status, 'pending')
  assert.equal(f.circ(), '100')
  assert.equal(f.state.mints.length, 0)
})
