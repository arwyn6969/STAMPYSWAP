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

// ============================================================================
// Repair-audit follow-up (1 October 2026): findings C01–C06. These assert the
// CORRECT behaviour under the full concurrency/restart model — stolen lease,
// read failure, stale write, restart migration — that the first repair missed.
// ============================================================================
const supply = (f, chain) => { const r = f.db.prepare('SELECT circulating_supply c FROM representations WHERE dest_chain=?').get(chain); return r ? r.c : null }

// C01: a stale supply snapshot taken BEFORE the reservation must not survive a stolen lease.
test('C01: stale snapshot before reservation cannot overissue after an expired-lease steal', async t => {
  const clock = { now: 1000000 }, entered = deferred(), resume = deferred(); let pause = true
  const a = await fixture(t, { collateral: '10', circulating: '0', clock, async beforeExec(sql, params) {
    if (pause && sql.startsWith('INSERT INTO operations') && params[0] === 'stale-A') { pause = false; entered.resolve(); await resume.promise }
  } })
  const b = await fixture(t, { db: a.db, clock }); t.after(() => resume.resolve())
  const first = a.call('/api/mint', mint('stale-A'), op); await entered.promise
  clock.now += 31000
  assert.equal((await b.call('/api/mint', mint('fresh-B'), op)).code, 200) // B wins the backing
  resume.resolve(); assert.notEqual((await first).code, 200) // A resumes, re-reads fresh state, is BLOCKED
  assert.equal(a.state.mints.length + b.state.mints.length, 1) // exactly one on-chain mint
  assert.equal(await a.context.assetCirculatingBase(1), 10n * 10n ** 18n) // 10 issued against 10 backing
})

// C02: a reservation-read failure must STOP issuance, never read as "zero reservations".
test('C02: a reservation-read error fails closed instead of reusing uncertain backing', async t => {
  let loseMint = true, failRead = false
  const f = await fixture(t, { collateral: '10', circulating: '0',
    afterMint() { if (loseMint) { loseMint = false; throw Error('accepted mint, response lost') } },
    beforeQuery(sql) { if (failRead && sql.startsWith('SELECT op_key, amount FROM operations')) throw Error('reservation read unavailable') } })
  assert.equal((await f.call('/api/mint', mint('uncertain'), op)).code, 502) // uncertain → reconcile
  failRead = true
  const second = await f.call('/api/mint', mint('new-key'), op)
  assert.notEqual(second.code, 200) // fail-closed (503 retryable), NOT a mint against uncertain backing
  assert.equal(f.state.mints.length, 1)
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='uncertain'").get().state, 'reconcile')
})

// C03: an older absolute cache write must not understate supply and permit extra issuance.
test('C03: a stale cache write cannot drive solvency — extra mint is blocked', async t => {
  const clock = { now: 1000000 }, entered = deferred(), resume = deferred(); let pause = true
  const a = await fixture(t, { collateral: '120', circulating: '100', clock, async beforeExec(sql, params) {
    if (pause && sql.startsWith('UPDATE representations SET circulating_supply=') && params[0] === '110') { pause = false; entered.resolve(); await resume.promise }
  } })
  const b = await fixture(t, { db: a.db, clock }); t.after(() => resume.resolve())
  const first = a.call('/api/mint', mint('sum-A'), op); await entered.promise; clock.now += 31000
  assert.equal((await b.call('/api/mint', mint('sum-B'), op)).code, 200)
  resume.resolve(); assert.equal((await first).code, 200)
  assert.notEqual((await a.call('/api/mint', mint('extra-C'), op)).code, 200) // blocked by the authoritative event sum
  assert.equal(a.state.mints.length + b.state.mints.length, 2)
  assert.equal(await a.context.assetCirculatingBase(1), 120n * 10n ** 18n) // 120 issued == 120 backing (never 130)
})

// C04: restart migration must not cancel a real-but-unmaterialized mint liability.
test('C04: restart baseline does not erase an unmaterialized mint event', async t => {
  let fail = true
  const f = await fixture(t, { collateral: '10', circulating: '0', beforeExec(sql) {
    if (fail && sql.startsWith('UPDATE representations SET circulating_supply=')) throw Error('cache write failed persistently') } })
  const first = await f.call('/api/mint', mint('new-rep-crash', 'ethereum'), op)
  assert.equal(first.code, 500); assert.equal(f.state.mints.length, 1)
  fail = false
  const reboot = await fixture(t, { db: f.db })
  const rep = f.db.prepare("SELECT id FROM representations WHERE dest_chain='ethereum'").get()
  const baseline = f.db.prepare('SELECT delta_base FROM accounting_events WHERE event_key=?').get('baseline:' + rep.id)
  assert.equal(baseline, undefined) // NO baseline seeded for an event-model rep (the defect inserted -10)
  assert.equal((await reboot.call('/api/reconcile', { kind: 'mint', op_key: 'new-rep-crash', resolution: 'completed', release_txid: 'known-onchain-mint' }, op)).code, 200)
  assert.equal(await reboot.context.repCirculatingBase(rep.id), 10n * 10n ** 18n) // liability preserved
  assert.notEqual((await reboot.call('/api/mint', mint('extra-after-restart', 'ethereum'), op)).code, 200) // blocked
  assert.equal(f.state.mints.length + reboot.state.mints.length, 1)
})

// C05: a spendable bare-pubkey output must be bounded by the value caps, not treated as data.
test('C05: a spendable bare public-key output is refused before signing', async () => {
  const bitcoin = dep('bitcoinjs-lib')
  const key = dep('ecpair').ECPairFactory(dep('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 9))
  const script = bitcoin.payments.p2pk({ pubkey: Buffer.from(key.publicKey) }).output
  assert.throws(() => bitcoin.address.fromOutputScript(script)) // not a standard address
  const from = btcSource
  const p = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin })
  p.addInput({ hash: '11'.repeat(32), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(from), value: 1000000 } })
  p.addOutput({ script, value: 999000 }); p.addOutput({ address: from, value: 500 })
  const signed = { n: 0 }
  const c = loadCustody(signed, p.toHex(), [{ index: 0, sighashType: 1 }])
  await assert.rejects(c.redeem({ tick: 'COIN', amount: '10', toAddress: dep('bitcoinjs-lib').payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).address }))
  assert.equal(signed.n, 0)
})

// C06: the move reconcile action must repair the missing materialization so the move can finish.
test('C06: move reconcile re-materializes the debit and the move can complete', async t => {
  let fail = true
  const f = await fixture(t, { beforeExec(sql) { if (fail && sql.startsWith('UPDATE representations SET circulating_supply=')) throw Error('persistent cache failure') } })
  assert.equal((await f.call('/api/move', f.move(), op)).code, 500); fail = false
  assert.equal((await f.call('/api/reconcile', undefined, op)).body.stuck_moves.length, 1) // visible
  assert.equal((await f.call('/api/reconcile', { kind: 'move', burn_txid: burnId, resolution: 'decremented' }, op)).code, 200)
  assert.equal(await f.context.repCirculatingBase(1), 90n * 10n ** 18n) // source debit materialized (100→90)
  assert.equal((await f.call('/api/move', f.move(), op)).code, 200) // move can now finish
  assert.equal(f.state.mints.length, 1)
})

// C07 (repair-audit follow-up): the mint solvency check reads `reserved` and the event-sum
// (`circulating`) separately. A peer mint that records its event BETWEEN those two reads must not
// slip through both (it migrates reserved→circulating the instant its event lands). Reading
// `reserved` FIRST makes that interleaving fail CLOSED (counted in reserved AND then in the
// append-only event sum = conservative block), never under-counted → never over-issued.
test('C07: a peer mint completing between the reserved and circulating reads cannot be missed', async t => {
  let fired = false
  const f = await fixture(t, { collateral: '10', circulating: '0',
    // when the mint solvency check finishes reading the reservation list, simulate a peer op 'W'
    // recording its mint event + completing — i.e. it migrates reserved→circulating mid-check.
    afterQuery(sql, params, rows, state) {
      if (!fired && sql.startsWith('SELECT op_key, amount FROM operations') && params[0] === 1) {
        fired = true
        const rep = f.db.prepare("SELECT id FROM representations WHERE dest_chain='base'").get()
        f.db.prepare("INSERT OR IGNORE INTO accounting_events(event_key,rep_id,delta_base,created_at) VALUES(?,?,?,?)").run('mint:peer-W', rep.id, (10n * 10n ** 18n).toString(), 1)
        f.db.prepare("INSERT OR IGNORE INTO operations(op_key,action,canonical_id,amount,chain,recipient,state,created_at,updated_at) VALUES('peer-W','mint',1,'10','base',?, 'completed',1,1)").run(owner.address)
      }
    } })
  // seed peer-W as reserved (no event yet) so the reservation read sees it before it "completes"
  f.db.prepare("INSERT INTO operations(op_key,action,canonical_id,amount,chain,recipient,state,created_at,updated_at) VALUES('peer-W','mint',1,'10','base',?, 'reserved',1,1)").run(owner.address)
  const r = await f.call('/api/mint', mint('A'), op)
  assert.notEqual(r.code, 200) // A is blocked — peer-W's 10 is counted (reserved→event), backing is full
  assert.equal(f.state.mints.length, 0)
  assert.ok((await f.context.assetCirculatingBase(1)) <= 10n * 10n ** 18n) // never exceeds the 10 backing
})

// ============================================================================
// Hardening pass (2 Oct): adversarial probes of paths the reviewer flagged —
// the reservedBase per-op event lookup under failure, event-replay idempotency,
// and one-burn-one-release on the custody redeem path.
// ============================================================================

// H1: the reservation read fails closed even when its PER-OP event-existence lookup errors (not just
// the top-level ops query). An unreadable liability must never be treated as zero reserved supply.
test('H1: a failing per-op reservation event-lookup fails the mint closed', async t => {
  const f = await fixture(t, { collateral: '10', circulating: '0',
    beforeQuery(sql) { if (sql.startsWith('SELECT 1 FROM accounting_events WHERE event_key=')) throw Error('event-existence lookup unavailable') } })
  // a peer reserved mint op (no event yet) forces reservedBase to run the per-op event lookup
  f.db.prepare("INSERT INTO operations(op_key,action,canonical_id,amount,chain,recipient,state,created_at,updated_at) VALUES('peer','mint',1,'10','base',?, 'reserved',1,1)").run(owner.address)
  const r = await f.call('/api/mint', mint('A'), op)
  assert.notEqual(r.code, 200) // fail-closed (503), not a mint against an unreadable reservation
  assert.equal(f.state.mints.length, 0)
})

// H2: the accounting-event ledger applies a logical effect EXACTLY once — re-applying the same
// event_key (a retried/duplicated decrement) converges to the same supply, never doubles. This is the
// invariant the whole redesign rests on, asserted directly against the primitive.
test('H2: re-applying the same accounting event_key is idempotent (no double effect)', async t => {
  const f = await fixture(t, { circulating: '100' }) // rep 1, baseline 100
  const D = 10n * 10n ** 18n
  await f.context.applyCirculatingDelta(1, -D, 'dup:evt-X')
  assert.equal(await f.context.repCirculatingBase(1), 90n * 10n ** 18n)
  await f.context.applyCirculatingDelta(1, -D, 'dup:evt-X') // SAME key again (retry / lost response)
  assert.equal(await f.context.repCirculatingBase(1), 90n * 10n ** 18n) // still 90 — applied once
  await f.context.applyCirculatingDelta(1, -D, 'dup:evt-Y') // a DIFFERENT key does apply
  assert.equal(await f.context.repCirculatingBase(1), 80n * 10n ** 18n)
})

// H3: one burn authorizes exactly one release — a retried custody redeem with the same burn_txid does
// not release again or decrement twice (idempotent via the shared consumed-burns registry).
test('H3: a retried custody redeem with the same burn cannot double-release', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '100' })
  const first = await f.call('/api/custody/redeem', await f.redeem()) // owner-signed, burnId
  assert.equal(first.code, 200)
  assert.equal(f.state.releases.length, 1)
  assert.equal(await f.context.repCirculatingBase(1), 90n * 10n ** 18n) // decremented once
  const retry = await f.call('/api/custody/redeem', await f.redeem()) // SAME burn_txid
  assert.notEqual(retry.code, 200) // burn already consumed → refused
  assert.equal(f.state.releases.length, 1) // NO second release
  assert.equal(await f.context.repCirculatingBase(1), 90n * 10n ** 18n) // NOT decremented again
})

// ============================================================================
// Self-audit (2 Oct): two NEW over-issue/over-release races the external audit
// did not probe — the mint's collateral snapshot vs a concurrent redeem, and
// two concurrent redeems. Both reproduced insolvency on 54b11dc before the fix.
// ============================================================================

// D01: a redeem that lands DURING a mint's liability-read window must not let the mint over-issue.
// The mint now reads availableCollateral LAST (after reserved + circulating) so a concurrent redeem's
// collateral reduction is always seen → fails closed. (Reproduced 20-vs-10-style insolvency pre-fix.)
test('D01: a redeem during a mint read window cannot cause over-issue', async t => {
  const entered = deferred(), resume = deferred(); let pause = true
  const a = await fixture(t, { collateral: '100', circulating: '100',
    async afterQuery(sql) { if (pause && sql.startsWith('SELECT op_key, amount FROM operations')) { pause = false; entered.resolve(); await resume.promise } } })
  const b = await fixture(t, { db: a.db })
  const mintP = a.call('/api/mint', mint('mintA'), op)
  await entered.promise
  assert.equal((await b.call('/api/custody/redeem', { tick: 'COIN', amount: '10', to: btcSource, chain: 'base' }, op)).code, 200)
  resume.resolve()
  const mr = await mintP
  assert.notEqual(mr.code, 200) // mint blocked — the collateral the redeem removed is no longer available
  const circ = await a.context.assetCirculatingBase(1)
  const avail = (await a.context.collateralBase(1)) - (await a.context.redeemedBase(1))
  assert.ok(circ <= avail, `insolvent: circulating ${circ} > available ${avail}`)
})

// D02: two concurrent redeems must not release more than circulating (reserve-first: each in-flight
// redeem's pending row is counted against circulating, so the second fails closed). Operator-gated,
// but prod's partial (nulls-allowed) burn index previously let both pending rows + both releases land.
test('D02: concurrent redeems cannot over-release past circulating', async t => {
  const entered = deferred(), resume = deferred(); let pause = false
  const a = await fixture(t, { collateral: '100', circulating: '10',
    async afterQuery(sql) { if (pause && sql.startsWith('SELECT delta_base FROM accounting_events WHERE rep_id')) { pause = false; entered.resolve(); await resume.promise } } })
  const b = await fixture(t, { db: a.db })
  pause = true
  const r1 = a.call('/api/custody/redeem', { tick: 'COIN', amount: '10', to: btcSource, chain: 'base' }, op)
  await entered.promise
  const r2 = await b.call('/api/custody/redeem', { tick: 'COIN', amount: '10', to: btcSource, chain: 'base' }, op)
  resume.resolve()
  const r1r = await r1
  const released = a.state.releases.length + b.state.releases.length
  assert.equal(released, 1) // exactly one release of 10 against 10 circulating
  assert.ok(r1r.code !== 200 || r2.code !== 200) // not both succeed
  assert.ok((await a.context.repCirculatingBase(1)) >= 0n)
})
