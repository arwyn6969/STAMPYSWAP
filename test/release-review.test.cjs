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

const historicalMints = [
  'CRWA5RPKt4gqXhWTQ5J3y6zpxbX99JkbyLquw66sR5c5',
  'HnaXwTXhPXW9WX1ivuAJ7whrb7BYVK3P4UMZ9GGxCVPL'
]
for (const mint of historicalMints) {
  test('historical Solana excess identity blocks release, move and mint even for an operator: ' + mint, async t => {
    const { op, owner } = require('./audit-e.fixture.cjs')
    const f = await fixture(t)
    f.db.prepare("UPDATE representations SET dest_chain='solana',dest_address=? WHERE id=1").run(mint)
    f.sol.verifyBurn = async (_tx, _mint, amount) => ({ valid: true, burned: amount, owner: owner.address })
    const before = f.db.prepare('SELECT * FROM collateral_ledger').all()
    for (const [route, body] of [
      ['/api/custody/redeem', await f.redeem({ chain: 'solana' })],
      ['/api/redeem', { tick: 'COIN', chain: 'solana', amount: '10' }],
      ['/api/move', f.move({ from_chain: 'solana' })],
      ['/api/mint', { tick: 'COIN', chain: 'solana', amount: '1', receive_address: owner.address, op_key: 'held-mint' }],
      ['/api/custody/verify-deposit', f.claim({ chain: 'solana' })]
    ]) {
      const r = await f.call(route, body, op)
      if (route === '/api/redeem') { assert.equal(r.code, 410, route); continue } // legacy route is permanently disabled
      assert.equal(r.code, 409, route)
      assert.equal(r.body.eligibility_hold, true, route)
    }
    assert.equal(f.state.releases.length, 0)
    assert.equal(f.state.mints.length, 0)
    assert.deepEqual(f.db.prepare('SELECT * FROM collateral_ledger').all(), before)
    assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
    assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n, 0)
    assert.equal(f.circ(), '100')
  })
}

test('held destination refuses a move before consuming or debiting its source burn', async t => {
  const { op } = require('./audit-e.fixture.cjs')
  const f = await fixture(t)
  f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply,status) VALUES(2,1,'solana',?,'0','CANONICAL')").run(historicalMints[0])
  const r = await f.call('/api/move', f.move({ to_chain: 'solana' }), op)
  assert.equal(r.code, 409)
  assert.equal(r.body.eligibility_hold, true)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM collateral_ledger WHERE direction='move-out'").get().n, 0)
  assert.equal(f.state.mints.length, 0)
  assert.equal(f.circ(), '100')
})

test('proof of reserves discloses historical representation holds without changing event liability', async t => {
  const f = await fixture(t)
  f.db.prepare("UPDATE representations SET dest_chain='solana',dest_address=? WHERE id=1").run(historicalMints[0])
  vm.runInContext('prices.btcUsd=async()=>null;prices.priceAsset=async()=>null', f.context)
  const r = await f.call('/api/reserves')
  assert.equal(r.code, 200)
  const chain = r.body.assets[0].chains[0]
  assert.equal(chain.eligibility_hold, true)
  assert.equal(chain.known_excess, '1500')
  assert.equal(r.body.assets[0].circulating, '100')
})
