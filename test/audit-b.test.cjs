// Checked-in PREVENTION tests for the 30-September-2026 release-readiness audit (findings B01–B09).
// Each test asserts the CORRECT (repaired) behaviour — it is RED on the audited 9689964 defect and GREEN
// on the repair. Adapted from the independent audit harness (audits/2026-09-30-9689964/), but pointed at
// the working tree (no source-hash pin) so it runs as part of `npm test`. Whole server, real Express,
// real EIP-191/BIP-322, local node:sqlite; chain/indexer/signer effects mocked; lease clock controlled.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { fixture, owner, attacker, token, burnId, btcSource, op, read, dep, load } = require('./audit-b.fixture.cjs')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const mint = (key, chain = 'base') => ({ tick: 'COIN', amount: '10', chain, receive_address: owner.address, op_key: key })
function pendingRedeem(f, id = 50) {
  f.db.prepare("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(?,1,'redeem','10','base',?,'reconcile')").run(id, burnId)
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'redeem','10')").run(burnId)
}

// ---- B01: a durable reservation holds the backing across the whole op, independent of the lock lease ----
test('B01: an expired-lease steal cannot overissue — the stolen-lock worker is blocked by the reservation', async t => {
  const clock = { now: 1000000 }; const entered = deferred(); const resume = deferred()
  const a = await fixture(t, { collateral: '10', circulating: '0', clock, async beforeMint() { entered.resolve(); await resume.promise } })
  const b = await fixture(t, { db: a.db, clock })
  const first = a.call('/api/mint', mint('lease-A'), op) // A reserves, passes solvency, pauses mid-mint
  await entered.promise
  clock.now += 31000 // A's 30s lease expires
  const second = await b.call('/api/mint', mint('lease-B'), op) // B steals the lease and tries to mint
  assert.notEqual(second.code, 200) // blocked — A's durable reservation still accounts for the backing
  resume.resolve(); assert.equal((await first).code, 200)
  assert.equal(a.state.mints.length + b.state.mints.length, 1) // exactly ONE on-chain mint
  assert.equal(a.circ(), '10')
  assert.equal(await a.context.collateralBase(1), 10n * 10n ** 18n)
})

// ---- B02: a committed debit whose response is lost is applied EXACTLY once ----
test('B02: a committed-then-lost decrement is not re-applied', async t => {
  let once = true
  const f = await fixture(t, { afterExec(sql) { if (once && sql.startsWith('UPDATE representations SET circulating_supply=')) { once = false; throw Error('DB committed the decrement; HTTP response was lost') } } })
  pendingRedeem(f)
  const r = await f.call('/api/reconcile', { kind: 'redeem', id: 50, resolution: 'released', release_txid: 'release' }, op)
  assert.equal(r.code, 200)
  assert.equal(f.circ(), '90') // decremented exactly once (the defect decremented to 80)
  const m = await f.call('/api/mint', mint('extra-ten'), op)
  assert.notEqual(m.code, 200) // no over-issue: 90 circ == 90 available backing
  assert.equal(f.state.mints.length, 0)
})

// ---- B03: a non-uniqueness representation-insert failure is never swallowed as a completed mint ----
test('B03: a failed new-representation insert does not report a phantom completed mint', async t => {
  let once = true
  const f = await fixture(t, { collateral: '10', circulating: '0', beforeExec(sql) { if (once && sql.startsWith('INSERT INTO representations')) { once = false; throw Error('insert failed before commit') } } })
  const first = await f.call('/api/mint', mint('new-rep-A', 'ethereum'), op)
  assert.notEqual(first.code, 200) // not a phantom success
  assert.equal(f.db.prepare("SELECT count(*) n FROM representations WHERE dest_chain='ethereum'").get().n, 0)
  const st = f.db.prepare("SELECT state FROM operations WHERE op_key='new-rep-A'").get()
  assert.notEqual(st && st.state, 'completed') // op kept for reconciliation, NOT completed
  const second = await f.call('/api/mint', mint('new-rep-B', 'ethereum'), op)
  assert.notEqual(second.code, 200) // backing stays reserved by the uncertain first mint
  assert.equal(f.state.mints.length, 1) // only the first on-chain mint happened
})

// ---- B04: an uncertain mint reserves its potential issuance against a different op_key ----
test('B04: an uncertain mint reserves backing so a different op cannot reuse it', async t => {
  let once = true
  const f = await fixture(t, { collateral: '10', circulating: '0', afterMint() { if (once) { once = false; throw Error('mint accepted; RPC response lost') } } })
  const a = await f.call('/api/mint', mint('unknown-A'), op)
  assert.equal(a.code, 502) // uncertain outcome
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='unknown-A'").get().state, 'reconcile')
  assert.equal(f.circ(), '0')
  const b = await f.call('/api/mint', mint('different-B'), op)
  assert.notEqual(b.code, 200) // the reservation blocks a second use of the same collateral
  assert.equal(f.state.mints.length, 1)
})

// ---- B05: a failed accounting phase is reported truthfully and stays in the repair inventory ----
test('B05: a persistent decrement failure does not report a finalized release', async t => {
  const f = await fixture(t, { beforeExec(sql) { if (sql.startsWith('UPDATE representations SET circulating_supply=')) throw Error('persistent DB failure') } })
  pendingRedeem(f)
  const r = await f.call('/api/reconcile', { kind: 'redeem', id: 50, resolution: 'released', release_txid: 'release' }, op)
  assert.notEqual(r.code, 200) // truthful: NOT a successful finalize
  assert.equal(f.circ(), '100') // unchanged
  const inv = await f.call('/api/reconcile', undefined, op)
  assert.equal(inv.body.stuck_redeems.length, 1) // still visible/resumable
})

test('B05: a failed source debit is not marked decremented and the move does not mint', async t => {
  const f = await fixture(t, { collateral: '200', circulating: '100', beforeExec(sql, params) { if (sql.startsWith('UPDATE representations SET circulating_supply=') && params[2] === 1) throw Error('persistent debit failure') } })
  const r = await f.call('/api/move', f.move(), op)
  assert.notEqual(r.code, 200)
  assert.equal(f.circ(), '100') // source NOT debited
  const mo = f.db.prepare("SELECT status FROM collateral_ledger WHERE direction='move-out'").get()
  assert.notEqual(mo && mo.status, 'decremented') // not falsely confirmed
  assert.equal(f.state.mints.length, 0) // destination NOT minted
})

// ---- B06: startup backfill respects recovery dispositions ----
test('B06: an explicitly aborted move burn is not reconsumed on restart', async t => {
  const f = await fixture(t)
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'move','10')").run(burnId)
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'pending')").run(burnId)
  assert.equal((await f.call('/api/reconcile', { kind: 'move', burn_txid: burnId, resolution: 'aborted' }, op)).code, 200)
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0)
  await f.context.migrateSchema()
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0) // NOT resurrected
})

test('B06: a NULL-status historical redemption burn is preserved and cannot be reused', async t => {
  const f = await fixture(t)
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(1,'redeem','10','base',?,NULL)").run(burnId)
  await f.context.migrateSchema()
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1) // NULL preserved in the registry
  const r = await f.call('/api/custody/redeem', await f.redeem())
  assert.equal(r.code, 409) // burn already consumed → no second release
  assert.equal(f.state.releases.length, 0)
})

// ---- B07: the schema gate proves the uniqueness it relies on ----
test('B07: an asset_locks table without uniqueness keeps writes contained', async t => {
  const f = await fixture(t)
  f.db.exec('DROP TABLE asset_locks; CREATE TABLE asset_locks(asset_id INTEGER,holder TEXT,acquired_at INTEGER,expires_at INTEGER)')
  vm.runInContext('SCHEMA_OK=false', f.context); await f.context.migrateSchema()
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), false)
})

test('B07: a partial unique index does not satisfy the operation uniqueness gate', async t => {
  const f = await fixture(t)
  f.db.exec(`DROP TABLE operations;
    CREATE TABLE operations(op_key TEXT,action TEXT,canonical_id INTEGER,amount TEXT,chain TEXT,recipient TEXT,state TEXT,created_at INTEGER,updated_at INTEGER,tx_id TEXT,result_json TEXT);
    CREATE UNIQUE INDEX only_completed ON operations(op_key) WHERE state='completed';`)
  vm.runInContext('SCHEMA_OK=false', f.context); await f.context.migrateSchema()
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), false)
})

// ---- B08: the withdrawal + move UI complete the owner-binding authorization ----
test('B08: the redeem form sends burn_txid + chain + an owner signature and is authorized', async t => {
  const f = await fixture(t)
  const html = read('public/index.html')
  const fields = { '#rr-tick': { value: 'COIN' }, '#rr-amount': { value: '10' }, '#rr-chain': { value: 'base' }, '#rr-txid': { value: burnId }, '#rr-to': { value: btcSource }, '#rr-out': { innerHTML: '' } }
  let lastReq, lastResp
  const ui = vm.createContext({
    window: { stampySignForChain: async (chain, msg) => await owner.signMessage(msg) },
    $: s => fields[s], esc: String, disp: String, loadReserves2() {},
    fetch: async (url, args) => { lastReq = JSON.parse(args.body); lastResp = await f.call('/' + url, lastReq); return { json: async () => lastResp.body } },
  })
  vm.runInContext(html.slice(html.indexOf('async function doRealRedeem(){'), html.indexOf("$('#rd-verify').addEventListener")), ui)
  await vm.runInContext('doRealRedeem()', ui)
  assert.equal(lastReq.burn_txid, burnId)
  assert.equal(lastReq.chain, 'base')
  assert.ok(lastReq.auth_sig, 'the final request carries the owner signature')
  assert.notEqual(lastResp.code, 401) // authorization satisfied (the defect returned 401)
  assert.equal(lastResp.code, 200)
})

test('B08: the move form signs the burn-owner binding and is authorized', async t => {
  const f = await fixture(t, { collateral: '200', circulating: '100' })
  const html = read('public/index.html')
  const fields = { '#mv-asset': { value: 'COIN' }, '#mv-amount': { value: '10' }, '#mv-from': { value: 'base' }, '#mv-to': { value: 'ethereum' }, '#mv-txid': { value: burnId }, '#mv-toaddr': { value: owner.address }, '#mv-out': { innerHTML: '' } }
  let lastReq, lastResp
  const ui = vm.createContext({
    window: { stampySignForChain: async (chain, msg) => await owner.signMessage(msg) },
    $: s => fields[s], esc: String, disp: String, loadReserves2() {},
    fetch: async (url, args) => { lastReq = JSON.parse(args.body); lastResp = await f.call('/' + url, lastReq); return { json: async () => lastResp.body } },
  })
  vm.runInContext(html.slice(html.indexOf('async function doMove(){'), html.indexOf("$('#mv-go').addEventListener")), ui)
  await vm.runInContext('doMove()', ui)
  assert.ok(lastReq.auth_sig, 'the final request carries the owner signature')
  assert.notEqual(lastResp.code, 401)
})

// ---- B09: the SRC-20 signing guard validates fee + transfer intent ----
function loadCustody(signedCounter, psbtHex, inputsToSign) {
  const bitcoin = dep('bitcoinjs-lib')
  return load('custody.js', n => {
    if (n === '@emblemvault/auth-sdk/signers/bitcoin') return { fetchBitcoinVaultInfo: async () => ({ btcAddresses: { p2wpkh: btcSource } }), toBitcoinSigner: async () => ({ signPsbt: async () => { signedCounter.n++; return { signedTxHex: '00' } } }) }
    if (n === 'bitcoinjs-lib') return bitcoin
    if (n === 'fs') return { existsSync: () => false }
    if (n === 'path') return require('node:path')
    if (n === './acme') return null
    throw Error('unexpected dependency ' + n)
  }, { process: { env: { STAMPY_CUSTODY_LIVE: '1' } }, fetch: async url => url.includes('/src20/create')
    ? { ok: true, json: async () => ({ hex: psbtHex, inputsToSign }) }
    : { ok: true, text: async () => 'aa'.repeat(32) } }).exports
}

test('B09: a PSBT with an excessive implied fee and no transfer payload is refused before signing', async () => {
  const bitcoin = dep('bitcoinjs-lib'); const from = btcSource
  const p = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin })
  p.addInput({ hash: '11'.repeat(32), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(from), value: 1000000 } })
  p.addOutput({ address: from, value: 546 }) // 999,454-sat implied fee; no payload/recipient
  const signed = { n: 0 }
  const c = loadCustody(signed, p.toHex(), [{ index: 0, sighashType: 1 }])
  const recipient = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).address
  await assert.rejects(c.redeem({ tick: 'COIN', amount: '10', toAddress: recipient }))
  assert.equal(signed.n, 0) // never signed
})

test('B09: a well-formed SRC-20 transfer (payload + dust recipient + small fee) still signs', async () => {
  const bitcoin = dep('bitcoinjs-lib'); const from = btcSource
  const recipient = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).address
  const p = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin })
  p.addInput({ hash: '11'.repeat(32), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(from), value: 10000 } })
  p.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('stampy:transfer', 'utf8')] }).output, value: 0 }) // transfer payload
  p.addOutput({ address: recipient, value: 330 }) // recipient dust marker
  p.addOutput({ address: from, value: 9000 }) // change back to vault; implied fee 670
  const signed = { n: 0 }
  const c = loadCustody(signed, p.toHex(), [{ index: 0, sighashType: 1 }])
  const r = await c.redeem({ tick: 'COIN', amount: '10', toAddress: recipient })
  assert.equal(r.released, true)
  assert.equal(signed.n, 1) // signed exactly once
})
