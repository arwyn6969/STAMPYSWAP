'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { fixture, owner, op } = require('./audit-e.fixture.cjs')
const mint = key => ({ tick: 'COIN', amount: '10', chain: 'base', receive_address: owner.address, op_key: key })

test('retains a live mint reservation during operator reconciliation and lease expiry', async t => {
  const clock = { now: Date.now() }
  let paused, resume
  const atSigner = new Promise(resolve => { paused = resolve })
  const continueMint = new Promise(resolve => { resume = resolve })
  const a = await fixture(t, { collateral: '10', circulating: '0', clock,
    beforeMint: async () => { paused(); await continueMint } })
  const b = await fixture(t, { db: a.db, clock })
  const pending = a.call('/api/mint', mint('paused-mint'), op)
  await atSigner
  clock.now += 31000
  let reconciliation, competing
  try {
    reconciliation = await b.call('/api/reconcile', { kind: 'mint', op_key: 'paused-mint', resolution: 'failed' }, op)
    competing = await b.call('/api/mint', mint('competing-mint'), op)
  } finally { resume() }
  const completed = await pending
  t.diagnostic(JSON.stringify({ reconciliationStatus: reconciliation.code, competingMintStatus: competing.code, originalMintStatus: completed.code, chainEffects: a.state.mints.length + b.state.mints.length, circulation: a.circ(), collateral: '10' }))
  assert.equal(reconciliation.code, 409)
  assert.equal(reconciliation.body.fencing_required, true)
  assert.equal(competing.code, 409)
  assert.equal(completed.code, 200)
  assert.equal(a.state.mints.length + b.state.mints.length, 1)
  assert.equal(a.circ(), '10')
  assert.equal(a.db.prepare("SELECT state FROM operations WHERE op_key='paused-mint'").get().state, 'completed')
})

for (const [kind, resolution] of [['mint', 'failed'], ['redeem', 'failed'], ['move', 'aborted'], ['stamp', 'failed'], ['burn', 'free']]) {
  test('operator cannot free uncertain ' + kind + ' identities without irreversible fencing', async t => {
    const f = await fixture(t)
    await vm.runInContext("opReserve('held', {action:'mint', canonical_id:1, amount:'10', chain:'base'})", f.context)
    f.db.prepare("INSERT INTO consumed_burns VALUES('held-burn','base',1,'redeem','owner','10',1)").run()
    const beforeOps = f.db.prepare('SELECT * FROM operations').all()
    const beforeBurns = f.db.prepare('SELECT * FROM consumed_burns').all()
    const r = await f.call('/api/reconcile', { kind, resolution, op_key: 'held', burn_txid: 'held-burn', chain: 'base', id: 1 }, op)
    assert.equal(r.code, 409)
    assert.equal(r.body.fencing_required, true)
    assert.deepEqual(f.db.prepare('SELECT * FROM operations').all(), beforeOps)
    assert.deepEqual(f.db.prepare('SELECT * FROM consumed_burns').all(), beforeBurns)
    assert.equal(f.state.releases.length + f.state.mints.length, 0)
  })
}

test('operator deposit claims require the depositor signature before accounting or mint', async t => {
  const f = await fixture(t)
  const claim = f.claim()
  delete claim.binding_sig
  const before = f.db.prepare('SELECT * FROM collateral_ledger').all()
  const r = await f.call('/api/custody/verify-deposit', claim, op)
  assert.equal(r.code, 401)
  assert.deepEqual(f.db.prepare('SELECT * FROM collateral_ledger').all(), before)
  assert.equal(f.state.mints.length, 0)
})

test('operator redemption requires a real burn and its owner binding', async t => {
  const f = await fixture(t)
  const unsigned = await f.redeem()
  delete unsigned.burn_txid
  assert.equal((await f.call('/api/custody/redeem', unsigned, op)).code, 401)
  const invalid = await f.redeem()
  invalid.auth_sig = 'invalid'
  assert.equal((await f.call('/api/custody/redeem', invalid, op)).code, 401)
  assert.equal(f.state.releases.length, 0)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
  assert.equal((await f.call('/api/custody/redeem', await f.redeem(), op)).code, 200)
  assert.equal(f.state.releases.length, 1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1)
})

test('operator moves require burn-owner authorization too', async t => {
  const f = await fixture(t)
  const move = f.move()
  delete move.auth_sig
  const r = await f.call('/api/move', move, op)
  assert.equal(r.code, 401)
  assert.equal(f.state.mints.length, 0)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
})

for (const chain of ['solana-mainnet', 'base-mainnet', 'ethereum-mainnet']) {
  test(chain + ' cannot be armed by operator access or a route/endpoint change', async t => {
    const f = await fixture(t)
    const before = f.db.prepare('SELECT * FROM collateral_ledger').all()
    for (const [route, body] of [
      ['/api/mint', { ...mint('closed-' + chain), chain }],
      ['/api/custody/verify-deposit', f.claim({ chain })],
      ['/api/custody/redeem', await f.redeem({ chain })],
      ['/api/move', f.move({ to_chain: chain })],
      ['/api/move', f.move({ from_chain: chain })],
      ['/api/mint/migrate-authority', { chain, tick: 'COIN' }],
      ['/api/amm/create', { chain, tickA: 'COIN', tickB: 'OTHER' }],
    ]) {
      const r = await f.call(route, body, op)
      assert.equal(r.code, 503, route)
      assert.equal(r.body.release_hold, true, route)
    }
    const direct = await vm.runInContext("mintCriticalCore({id:1},'10','recipient','" + chain + "','direct')", f.context)
    assert.equal(direct.status, 503)
    assert.deepEqual(f.db.prepare('SELECT * FROM collateral_ledger').all(), before)
    assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n, 0)
    assert.equal(f.state.mints.length + f.state.releases.length, 0)
  })
}

test('Bitcoin finality defaults to six and rejects unsafe or malformed configuration', async t => {
  const f = await fixture(t)
  assert.equal(vm.runInContext('CONFIRMS', f.context), 6)
  assert.equal(vm.runInContext('ACME_CONFIRMS', f.context), 6)
  for (const value of ['2', '0', '-1', '6junk', 'NaN', 'Infinity', '6.5', '100001']) {
    await assert.rejects(fixture(t, { env: { DEPOSIT_CONFIRMATIONS: value } }), /must be an integer between 6/)
  }
})

for (const chain of ['solana-mainnet', 'base-mainnet', 'ethereum-mainnet']) {
  test(chain + ' reconciliation derives the hold from stored identities, ignoring missing or false selectors', async t => {
    const f = await fixture(t)
    f.db.prepare('UPDATE representations SET dest_chain=? WHERE id=1').run(chain)
    f.db.prepare("INSERT INTO operations(op_key,action,canonical_id,amount,chain,state) VALUES('stored-mainnet','mint',1,'10',?,'reserved')").run(chain)
    f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,status,burn_txid) VALUES(1,'redeem','10',?,'pending','held-mainnet-burn')").run(chain)
    const id = Number(f.db.prepare("SELECT id FROM collateral_ledger WHERE direction='redeem'").get().id)
    f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,status,btc_txid) VALUES(1,'move-out','10',?,'pending','held-mainnet-move')").run(chain)
    const beforeEvents = f.db.prepare('SELECT * FROM accounting_events').all()
    for (const suppliedChain of [undefined, 'base']) {
      for (const body of [
        {kind:'mint',op_key:'stored-mainnet',resolution:'completed',release_txid:'unverified'},
        {kind:'redeem',id,resolution:'released',release_txid:'unverified'},
        {kind:'move',burn_txid:'held-mainnet-move',resolution:'decremented'},
      ]) {
        if (suppliedChain) body.chain = suppliedChain
        const r = await f.call('/api/reconcile', body, op)
        assert.equal(r.code, 503)
        assert.equal(r.body.release_hold, true)
      }
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM accounting_events').all(), beforeEvents)
    assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='stored-mainnet'").get().state, 'reserved')
  })
}

test('Solana authority API preserves the explicit mainnet identity', async t => {
  const f = await fixture(t)
  const seen = []
  f.sol.authorityInfo = async chain => { seen.push(chain); return {network:chain,writes_enabled:false} }
  const r = await f.call('/api/mint/authority?chain=solana-mainnet')
  assert.equal(r.code, 200)
  assert.deepEqual(seen, ['solana-mainnet'])
  assert.equal(r.body.writes_enabled, false)
})

test('protocol swap derives the mainnet hold from the stored pool before funding or signing', async t => {
  const f = await fixture(t)
  f.db.exec('ALTER TABLE pools ADD COLUMN chain TEXT')
  f.db.prepare("INSERT INTO pools(id,chain) VALUES(1,'base-mainnet')").run()
  const r = await f.call('/api/amm/swap', {pool_id:1,op_key:'held-pool',token_in:'token',amount_in:'1'}, op)
  assert.equal(r.code, 503)
  assert.equal(r.body.release_hold, true)
  assert.equal(f.state.mints.length, 0)
})

test('reserve status identifies ledger-only arithmetic without claiming chain or release readiness', async t => {
  const f = await fixture(t)
  vm.runInContext('prices.btcUsd=async()=>null; prices.priceAsset=async()=>null', f.context)
  const r = await f.call('/api/reserves')
  assert.equal(r.code, 200)
  assert.equal(r.body.solvency_scope, 'accounting_ledger_only')
  assert.equal(r.body.chain_reconciled, false)
  assert.equal(r.body.release_ready, false)
})
