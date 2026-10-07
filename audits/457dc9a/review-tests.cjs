// Offline failure-injection review of 457dc9a. No server boot, HTTP, or real signers.
// Run: STAMPYSWAP_REVIEW_TREE=/path/to/457dc9a node --experimental-sqlite --test audits/457dc9a/review-tests.cjs
// Uses verbatim server.js slices and SQLite with the claimed PK/UNIQUE constraints.
// A passing counterexample test means the reviewed code exhibits the stated defect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const root = process.env.STAMPYSWAP_REVIEW_TREE || '/private/tmp/stampyswap-audit-latest-20260921';
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex'), '33da7571b214c338e37c9a6cdaf66d887c2534d7', 'must run against exact reviewed server.js');
const lines = source.split('\n');
const slice = (a, b) => lines.slice(a - 1, b).join('\n');
const recovery = require(path.join(root, 'recovery.js'));
const asset = { id: 7, exact_ticker: 'TEST', source_protocol: 'src-20', decimals: 8, max_supply: '1000000', whitelisted: 1 };
function database(collateral = '100', circulating = '100') {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE representations (id INTEGER PRIMARY KEY, canonical_id INTEGER, dest_chain TEXT, dest_address TEXT, dest_symbol TEXT, status TEXT, authority_model TEXT, circulating_supply TEXT, updated_at INTEGER);
    CREATE TABLE collateral_ledger (id INTEGER PRIMARY KEY, canonical_id INTEGER, direction TEXT, amount TEXT, dest_chain TEXT, btc_txid TEXT UNIQUE, burn_txid TEXT, vault_address TEXT, confirmations INTEGER, status TEXT, created_at INTEGER, dest_tx TEXT);
    CREATE TABLE consumed_burns (burn_txid TEXT PRIMARY KEY, chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER);
    CREATE TABLE operations (op_key TEXT PRIMARY KEY, action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT, state TEXT, created_at INTEGER, updated_at INTEGER, tx_id TEXT, result_json TEXT);
    CREATE TABLE canonical_assets (id INTEGER PRIMARY KEY, exact_ticker TEXT);
    INSERT INTO canonical_assets VALUES (7, 'TEST');
  `);
  db.prepare('INSERT INTO representations (id,canonical_id,dest_chain,dest_address,circulating_supply) VALUES (1,7,?,?,?)').run('base', 'source-contract', circulating);
  if (collateral !== '0') db.prepare("INSERT INTO collateral_ledger (canonical_id,direction,amount,btc_txid,status) VALUES (7,'deposit',?,'seed','confirmed')").run(collateral);
  return db;
}
function worker(db, hooks = {}) {
  const routes = new Map();
  const state = { mints: [], signatures: [] };
  const sandbox = {
    Buffer, crypto, console, recovery, labels: require(path.join(root, 'labels.js')),
    now: () => 12345,
    operatorToken: () => 'audit-token',
    requireOperator: () => false,
    VAULT_ADDR: 'vault', CONFIRMS: 2, ACME_CONFIRMS: 3,
    SCHEMA_OK: false,
    getAssetByTick: async () => asset, resolveAsset: async () => asset,
    verifyRepBurn: async () => ({ valid: true, owner: 'holder' }),
    verifyDepositTxid: async (_tx, _tick, amt) => ({ found: true, valid: Number(amt) <= 100, confirmed: true, confirmations: 10, source: 'depositor' }),
    Bip322Verifier: { verifySignature: (owner, msg, sig) => { state.signatures.push({ owner, msg, sig }); return owner === 'depositor' && sig === 'signed:' + msg; } },
    solanaAuthorityMode: () => 'emblem', evmAuthorityMode: () => 'emblem',
    evmMint: {
      isSupported: c => c === 'base' || c === 'ethereum',
      deployAndMint: async args => {
        if (hooks.mint) await hooks.mint(args);
        state.mints.push(args);
        return { contract: 'destination-contract', txHash: 'mint-' + state.mints.length, explorer: 'offline' };
      },
    },
    dbQuery: async (sql, args = []) => {
      if (hooks.beforeQuery) await hooks.beforeQuery(sql, args);
      const rows = db.prepare(sql).all(...args);
      if (hooks.afterQuery) await hooks.afterQuery(sql, args, rows);
      return rows;
    },
    dbExec: async (sql, args = []) => {
      if (hooks.beforeExec) await hooks.beforeExec(sql, args);
      const result = db.prepare(sql).run(...args);
      if (hooks.afterExec) await hooks.afterExec(sql, args, result);
      return result;
    },
    app: { post: (p, h) => routes.set('POST ' + p, h), get: (p, h) => routes.set('GET ' + p, h) },
  };
  vm.createContext(sandbox);
  for (const [a,b] of [[151,156],[177,182],[188,205],[451,453],[464,472],[590,599],[778,801],[806,815],[929,1026],[1059,1066],[1083,1097],[1098,1163],[1454,1595],[1680,1742],[2172,2197]]) {
    vm.runInContext(slice(a,b), sandbox, { filename: path.join(root, 'server.js'), lineOffset: a - 1 });
  }
  return {
    state, sandbox,
    async call(p, body, headers = { 'x-operator-token': 'audit-token' }) {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
      await routes.get('POST ' + p)({ body, headers }, res);
      return { status: res.statusCode, body: res.body };
    },
  };
}
const deposit = { tick: 'TEST', amount: '10', txid: 'deposit-one', receive_address: 'recipient-A', chain: 'ethereum' };
const move = { tick: 'TEST', amount: '10', burn_txid: '0xburn', from_chain: 'base', to_chain: 'ethereum', to_address: 'recipient-A' };
const amount = (db, chain = 'base') => db.prepare('SELECT circulating_supply FROM representations WHERE dest_chain=?').get(chain)?.circulating_supply;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function pendingRedeem(db) {
  const r = db.prepare("INSERT INTO collateral_ledger (canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES (7,'redeem','10','base','0xburn','pending')").run();
  db.prepare("INSERT INTO consumed_burns (burn_txid,chain,canonical_id,purpose,amount) VALUES ('0xburn','base',7,'redeem','10')").run();
  return r.lastInsertRowid;
}
test('COUNTEREXAMPLE A: released reconcile can decrement twice after final write fails', async () => {
  const db = database(); const id = pendingRedeem(db); let fail = true;
  const w = worker(db, { beforeExec(sql) { if (fail && sql.includes("SET status='released'")) { fail = false; throw Error('injected ledger outage'); } } });
  const first = await w.call('/api/reconcile', { kind: 'redeem', id, resolution: 'released' });
  assert.equal(first.status, 500); assert.equal(amount(db), '90');
  assert.equal(db.prepare('SELECT status FROM collateral_ledger WHERE id=?').get(id).status, 'pending');
  const retry = await w.call('/api/reconcile', { kind: 'redeem', id, resolution: 'released' });
  assert.equal(retry.status, 200); assert.equal(amount(db), '80');
  assert.equal(await w.sandbox.collateralBase(7) - await w.sandbox.redeemedBase(7), 90n * 10n ** 18n);
  assert.equal((await w.sandbox.mintCritical(asset, '10', 'attacker', 'ethereum', 'extra-mint')).status, 200);
  // Actual pre-existing post-burn circulation was 90; 10 additional tokens now make 100 against 90 collateral.
});
test('COUNTEREXAMPLE A: failed reconcile swallows burn deletion failure and makes it terminal', async () => {
  const db = database(); const id = pendingRedeem(db);
  const w = worker(db, { beforeExec(sql) { if (sql.startsWith('DELETE FROM consumed_burns')) throw Error('injected delete outage'); } });
  const result = await w.call('/api/reconcile', { kind: 'redeem', id, resolution: 'failed' });
  assert.equal(result.status, 200); assert.equal(result.body.freed_burn, true);
  assert.ok(db.prepare('SELECT * FROM consumed_burns').get());
  assert.equal((await w.call('/api/reconcile', { kind: 'redeem', id, resolution: 'failed' })).status, 409);
});
test('COUNTEREXAMPLE A: startup backfill re-consumes successfully freed failed redeem', async () => {
  const db = database(); const id = pendingRedeem(db); const w = worker(db);
  assert.equal((await w.call('/api/reconcile', { kind: 'redeem', id, resolution: 'failed' })).status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 0);
  await w.sandbox.migrateSchema();
  assert.equal(db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1);
});
test('COUNTEREXAMPLE B: parent deposit op is ignored and a possibly completed mint repeats', async () => {
  const db = database('0','0'); const w = worker(db);
  db.prepare("INSERT INTO collateral_ledger (canonical_id,direction,amount,btc_txid,status) VALUES (7,'deposit','10',?,'confirmed')").run(deposit.txid);
  db.prepare("INSERT INTO operations (op_key,state,recipient) VALUES (?,'reserved','recipient-A')").run('deposit-mint:' + deposit.txid + ':ethereum:recipient-A');
  // Parent mint landed, then accounting write failed: chain supply=10, database supply=0.
  const r = await w.call('/api/custody/verify-deposit', deposit);
  assert.equal(r.status, 200); assert.equal(w.state.mints.length, 1); assert.equal(amount(db,'ethereum'), '10');
  assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n, 2);
  // Actual chain supply is now 20 against the unchanged 10-unit deposit.
});
test('COUNTEREXAMPLE B: parent move op is ignored on burn resume', async () => {
  const db = database('100','90'); const w = worker(db);
  db.prepare("INSERT INTO consumed_burns (burn_txid,chain,canonical_id,purpose,amount) VALUES ('0xburn','base',7,'move','10')").run();
  db.prepare("INSERT INTO operations (op_key,state,recipient) VALUES ('move-mint:0xburn:ethereum:recipient-A','reserved','recipient-A')").run();
  assert.equal((await w.call('/api/move', move)).status, 200);
  assert.equal(w.state.mints.length, 1); assert.equal(amount(db), '90');
});
test('COUNTEREXAMPLE B: two workers first deposit; credit creator deletes backing after peer mint', async () => {
  const db = database('0','0'); const creditInserted = deferred(); const resumeA = deferred();
  const a = worker(db, { async afterExec(sql) { if (sql.includes("VALUES (?, 'deposit'")) { creditInserted.resolve(); await resumeA.promise; } } });
  const b = worker(db);
  const first = a.call('/api/custody/verify-deposit', deposit);
  await creditInserted.promise;
  const second = await b.call('/api/custody/verify-deposit', deposit);
  assert.equal(second.status, 200); resumeA.resolve();
  const original = await first;
  assert.equal(original.status, 409); assert.equal(original.body.deposit_reverted, true);
  assert.equal(b.state.mints.length, 1); assert.equal(amount(db,'ethereum'), '10');
  assert.equal(await a.sandbox.collateralBase(7), 0n);
});
test('COUNTEREXAMPLE B: consumed move marker survives failed source decrement; retry is stranded', async () => {
  const db = database(); let fail = true;
  const w = worker(db, { beforeExec(sql) { if (fail && sql.startsWith('UPDATE representations')) { fail = false; throw Error('injected source update outage'); } } });
  assert.equal((await w.call('/api/move', move)).status, 500);
  assert.ok(db.prepare('SELECT * FROM consumed_burns').get()); assert.equal(amount(db), '100');
  const retry = await w.call('/api/move', move);
  assert.equal(retry.status, 409); assert.equal(retry.body.resumable, true); assert.equal(amount(db), '100');
  assert.equal(w.state.mints.length, 0); assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n, 0);
});
test('COUNTEREXAMPLE B: completed move retry reports failure before consulting cached operation', async () => {
  const db = database(); const w = worker(db);
  assert.equal((await w.call('/api/move', move)).status, 200);
  const retry = await w.call('/api/move', move);
  assert.equal(retry.status, 409); assert.equal(retry.body.resumable, true);
  assert.equal(w.state.mints.length, 1); assert.equal(amount(db), '90');
});
test('PASS: normal failed destination mint resumes without a second decrement or burn claim', async () => {
  const db = database(); let fail = true;
  const w = worker(db, { mint() { if (fail) { fail = false; throw Object.assign(Error('no gas'), { code: 'UNFUNDED' }); } } });
  assert.equal((await w.call('/api/move', move)).status, 503); assert.equal(amount(db), '90');
  assert.equal((await w.call('/api/move', move)).status, 200); assert.equal(amount(db), '90');
  assert.equal(w.state.mints.length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM collateral_ledger WHERE direction='move-out'").get().n, 1);
});
test('PASS: same-worker concurrent first deposits mint and credit once', async () => {
  const db = database('0','0'); const w = worker(db);
  const results = await Promise.all([w.call('/api/custody/verify-deposit',deposit),w.call('/api/custody/verify-deposit',deposit)]);
  assert.deepEqual(results.map(r => r.status).sort(),[200,409]); assert.equal(w.state.mints.length,1);
  assert.equal(await w.sandbox.collateralBase(7),10n * 10n ** 18n);
});
test('PASS: receive_address is in the verified message before credit/resume', async () => {
  const db = database('0','0'); const w = worker(db);
  const auth = { ...deposit, source_address:'depositor' };
  auth.binding_sig = 'signed:' + w.sandbox.depositBindingMessage({ source:'depositor',receive:deposit.receive_address,tick:'TEST',amount:'10' });
  const changed = await w.call('/api/custody/verify-deposit',{ ...auth, receive_address:'thief' },{});
  assert.equal(changed.status,401); assert.equal(w.state.mints.length,0);
  assert.equal((await w.call('/api/custody/verify-deposit',auth,{})).status,200);
});
test('PASS: definite first mint failure deletes new credit; uncertainty preserves credit and op', async () => {
  for (const code of ['UNFUNDED','TIMEOUT']) {
    const db=database('0','0'); const w=worker(db,{mint(){throw Object.assign(Error(code),{code});}});
    const r=await w.call('/api/custody/verify-deposit',deposit);
    assert.equal(r.body.deposit_reverted,code==='UNFUNDED');
    assert.equal(await w.sandbox.collateralBase(7),code==='UNFUNDED'?0n:10n*10n**18n);
    assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,code==='UNFUNDED'?0:1);
  }
});
test('PASS: first over-circulating attempt frees burn and does not decrement', async () => {
  const db=database('100','0'); const w=worker(db);
  assert.equal((await w.call('/api/move',move)).status,409);
  assert.equal(db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
  assert.equal(amount(db),'0'); assert.equal(w.state.mints.length,0);
});
test('PASS: safeEqual rejects unequal UTF-8 byte lengths and missing operator token', () => {
  const w=worker(database());
  for(const [a,b,want] of [['x','xx',false],['audit-token','audit-token',true],['same','diff',false],['é','e',false]]) assert.equal(w.sandbox.safeEqual(a,b),want);
  assert.equal(w.sandbox.isOperator({headers:{}}),false);
});
test('PASS: vault lock serializes across asset locks and continues after rejection', async () => {
  const w=worker(database()); let active=0,max=0;
  await Promise.allSettled([1,2,3].map(id=>w.sandbox.withAssetLock(id,()=>w.sandbox.withBtcVaultLock(async()=>{
    active++; max=Math.max(max,active); await Promise.resolve(); active--; if(id===2)throw Error('broadcast failure');
  }))));
  assert.equal(max,1); assert.equal(active,0);
});
