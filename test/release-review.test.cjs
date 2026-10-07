// Faults use local SQLite and mocked external effects; no live service or signing authority.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm')
const { fixture } = require('./audit-e.fixture.cjs')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('schema gate recovers from a transient failed probe and stops its interval', async t => {
  let retry, available = false, stopped = 0
  const f = await fixture(t, {
    setInterval(callback) { retry = callback; return { unref() {} } },
    clearInterval() { stopped++ },
    beforeQuery(sql) { if (!available && sql.includes('SELECT burn_txid FROM consumed_burns')) throw Error('temporary DB outage') }
  })
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), false)
  assert.equal(typeof retry, 'function')
  available = true
  await retry()
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), true)
  assert.equal(stopped, 1)
})

test('slow schema retry cannot overlap another interval probe', async t => {
  let retry, ready = false, probes = 0
  const entered = deferred(), resume = deferred()
  const f = await fixture(t, {
    setInterval(callback) { retry = callback; return { unref() {} } },
    beforeQuery(sql) {
      if (!sql.includes('SELECT burn_txid FROM consumed_burns')) return
      if (!ready) throw Error('temporary DB outage')
      probes++; entered.resolve(); return resume.promise
    }
  })
  ready = true
  const pending = retry()
  await entered.promise
  try { await retry(); assert.equal(probes, 1) }
  finally { resume.resolve(); await pending }
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), true)
})

test('completion resolves an acknowledgement lost after the actual commit', async t => {
  const f = await fixture(t, { afterExec(sql) {
    if (sql.startsWith("UPDATE operations SET state='completed'")) throw Error('response lost after commit')
  } })
  const meta = { action: 'mint', canonical_id: 1, amount: '1', chain: 'base' }
  assert.equal((await f.context.opReserve('ambiguous-completion', meta)).fresh, true)
  assert.equal((await f.context.opComplete('ambiguous-completion', 'tx', { minted: true })).ok, true)
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='ambiguous-completion'").get().state, 'completed')
})

for (const mismatch of ['tx_id', 'result_json']) {
  test('completion does not accept a different durable ' + mismatch, async t => {
    const f = await fixture(t)
    await f.context.opReserve('different-completion', { action: 'mint', canonical_id: 1, amount: '1', chain: 'base' })
    f.db.prepare("UPDATE operations SET state='completed',tx_id=?,result_json=? WHERE op_key='different-completion'")
      .run(mismatch === 'tx_id' ? 'other' : 'tx', mismatch === 'result_json' ? '{"minted":false}' : '{"minted":true}')
    vm.runInContext("const actualExec=dbExec; dbExec=(sql,params)=>sql.startsWith(\"UPDATE operations SET state='completed'\")?Promise.resolve({changes:0}):actualExec(sql,params)", f.context)
    assert.equal((await f.context.opComplete('different-completion', 'tx', { minted: true })).ok, false)
  })
}

test('schema retries continue after a prolonged outage and stop only after verification', async t => {
  let retry, available = false, stopped = 0
  const f = await fixture(t, {
    setInterval(callback) { retry = callback; return { unref() {} } },
    clearInterval() { stopped++ },
    beforeQuery(sql) { if (!available && sql.includes('SELECT burn_txid FROM consumed_burns')) throw Error('DB unavailable') }
  })
  for (let i = 0; i < 121; i++) await retry()
  assert.equal(stopped, 0)
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), false)
  available = true
  await retry()
  assert.equal(stopped, 1)
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), true)
})
