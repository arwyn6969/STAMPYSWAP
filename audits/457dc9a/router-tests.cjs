// Audit evidence, not a prevention suite: OPEN/NEW tests pass when a defect is reproduced.
// Uses real Express routing/middleware and real EIP-191/BIP-322 verification.
// All blockchain/indexer/database effects are local fixtures. No vault keys are loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const ROOT = process.env.STAMPY_AUDIT_SOURCE || '/private/tmp/stampyswap-audit-latest-20260921';
const dep = createRequire(path.join(process.env.STAMPY_AUDIT_DEPS || '/private/tmp/stampyswap-audit-621499e', 'package.json'));
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'server.js'))).digest('hex'), JSON.parse(fs.readFileSync(path.join(__dirname, 'source-sha256.json')))["server.js"], 'pinned source');
const expressReal = dep('express');
const { ethers } = dep('ethers');
const bip = dep('bip322-js');
const bitcoin = dep('bitcoinjs-lib');
const btcKey = dep('ecpair').ECPairFactory(dep('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 7));
// Well-known fixture key only, never use it to hold funds.
const btcSource = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(btcKey.publicKey) }).address;
const owner = new ethers.Wallet('0x' + '1'.repeat(64));
const attacker = new ethers.Wallet('0x' + '2'.repeat(64));
const token = '0x' + '3'.repeat(40);
const burnId = '0x' + 'ab'.repeat(32);
const op = { 'x-operator-token': 'local-fixture-operator' };
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
function load(file, req, globals = {}) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: req,
    __dirname: ROOT, process: { env: {} }, console: { log() {}, error() {} }, Buffer,
    AbortController, TextEncoder, setTimeout, clearTimeout, ...globals });
  vm.runInContext(read(file), context, { filename: file });
  return { exports: module.exports, context };
}
async function fixture(t, options = {}) {
  const { protocol = 'src-20', decimals = 8, collateral = '100', circulating = '100',
    maintenance = true, preview = false, uniqueBurnColumn = false } = options;
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE canonical_assets(id INTEGER PRIMARY KEY, exact_ticker TEXT, source_protocol TEXT, max_supply TEXT, decimals INTEGER, whitelisted INTEGER, deploy_tx TEXT);
    CREATE TABLE representations(id INTEGER PRIMARY KEY, canonical_id INTEGER, dest_chain TEXT, dest_address TEXT, circulating_supply TEXT, status TEXT, updated_at INTEGER, dest_symbol TEXT, authority_model TEXT);
    CREATE TABLE collateral_ledger(id INTEGER PRIMARY KEY, canonical_id INTEGER, direction TEXT, amount TEXT, dest_chain TEXT, btc_txid TEXT UNIQUE, burn_txid TEXT ${uniqueBurnColumn ? 'UNIQUE' : ''}, vault_address TEXT, confirmations INTEGER, status TEXT, created_at INTEGER, dest_tx TEXT);
    CREATE TABLE consumed_burns(burn_txid TEXT PRIMARY KEY, chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER);
    CREATE TABLE stamp_bridges(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, stamp_protocol TEXT, ratio INTEGER, burn_address TEXT, enabled INTEGER);
    CREATE TABLE bridge_ops(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, amount TEXT, burn_txid TEXT UNIQUE, user_address TEXT, release_txid TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE operations(op_key TEXT PRIMARY KEY, action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT, state TEXT, created_at INTEGER, updated_at INTEGER, tx_id TEXT, result_json TEXT);
    CREATE TABLE pools(id INTEGER PRIMARY KEY, canonical_a INTEGER, canonical_b INTEGER);
  `);
  db.prepare('INSERT INTO canonical_assets VALUES (1,?,?,?,?,1,?)').run('COIN', protocol, '1000000', decimals, 'deploy');
  db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply,status) VALUES(1,1,'base',?,?,'CANONICAL')").run(token, circulating);
  if (collateral !== '0') db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit',?,'initial','confirmed')").run(collateral);
  const state = { releases: [], mints: [], failMint: false, failDb: false, ambiguousRelease: false, vaultBalance: '101',
    sends: [{ source: btcSource, destination: 'vault', status: 'valid', quantity: '1', tx_hash: 'deposit', block_index: 10 }],
    src: { op: 'TRANSFER', tick: 'COIN', creator: btcSource, destination: 'vault', amt: '10', block_index: 10 },
    receipt: { status: 1, blockNumber: 10, confirmations: async () => 1, logs: [{ address: token,
      topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash],
      data: ethers.toBeHex(ethers.parseUnits('10', 18), 32) }] } };
  const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  async function fetchFixture(url) {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v2/src20/tx/')) return json({ data: { ...state.src, tx_hash: decodeURIComponent(u.pathname.split('/').pop()) }, last_block: 30 });
    if (u.pathname.endsWith('/balances')) return json({ result: ['COIN', 'STAMP'].map(asset => ({ asset, quantity: state.vaultBalance })) });
    if (u.pathname.endsWith('/sends')) return json({ result: state.sends });
    if (u.pathname.endsWith('/blocks/last')) return json({ result: { block_index: 30 } });
    throw Error('External request blocked: ' + url);
  }
  const pure = file => load(file, n => { throw Error('Unexpected import: ' + n); }, { fetch: fetchFixture }).exports;
  const cp = pure('counterparty.js'), acme = pure('acme.js');
  const evm = load('evm-mint.js', n => {
    if (n === 'ethers') return { ethers };
    if (n === './evm-signer') return { address: attacker.address, provider: () => ({ getTransactionReceipt: async () => state.receipt, getBlockNumber: async () => state.head || 30 }) };
    if (n === './erc20-artifact.json') return JSON.parse(read('erc20-artifact.json'));
    throw Error('Unexpected import: ' + n);
  }).exports;
  evm.deployAndMint = async args => {
    if (state.failMint) throw Error('fixture signer unavailable before sending');
    state.mints.push(args); return { contract: token, txHash: 'mint-' + state.mints.length };
  };
  const custody = { depositAddress: async () => 'vault', isLive: () => true,
    status: async () => ({ deposits_live: true, live: true }),
    redeem: async args => {
      state.releases.push(args);
      if (state.ambiguousRelease) { state.ambiguousRelease = false; throw Error('broadcast accepted, response connection reset'); }
      return { released: true, txid: 'release-' + state.releases.length };
    } };
  let app;
  function express() { app = expressReal(); app.listen = () => {}; return app; }
  Object.assign(express, expressReal);
  const dependencies = { express, path, crypto: require('node:crypto'), tweetnacl: dep('tweetnacl'),
    bs58: dep('bs58'), './sol-mint': {}, './evm-mint': evm, './amm': {}, './custody': custody,
    './recovery': require(path.join(ROOT, 'recovery.js')), './labels': require(path.join(ROOT, 'labels.js')), './counterparty': cp, './acme': acme, './prices': {}, './squads': null, './safe': null,
    'bip322-js': bip, fs: { existsSync: () => false }, ethers };
  const query = async (sql, params = []) => db.prepare(sql).all(...params);
  const exec = async (sql, params = []) => {
    if (state.failDb && sql.startsWith('UPDATE representations')) { state.failDb = false; throw Error('fixture database failure after effect'); }
    return db.prepare(sql).run(...params);
  };
  const { context } = load('server.js', n => {
    if (!(n in dependencies)) throw Error('Unexpected import: ' + n); return dependencies[n];
  }, { fetch: fetchFixture, process: { env: { VAULT_DEPOSIT_ADDRESS: 'vault', OPERATOR_TOKEN: op['x-operator-token'],
    STAMPY_MAINTENANCE: maintenance ? '1' : '0', STAMPY_PREVIEW: preview ? '1' : '0' } },
    setInterval: () => ({ unref() {} }), __query: query, __exec: exec });
  vm.runInContext('dbQuery = __query; dbExec = __exec', context);
  await new Promise(setImmediate); // let the intentionally disconnected startup check settle
  await vm.runInContext('migrateSchema()', context);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  async function call(url, body, headers = {}) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { code: r.status, body: await r.json() };
  }
  const claim = (extra = {}) => {
    const body = { tick: 'COIN', amount: '10', txid: 'deposit', chain: 'base', receive_address: attacker.address, source_address: btcSource, ...extra };
    const msg = `StampySwap deposit authorization\nSource: ${btcSource}\nReceive: ${body.receive_address}\nAsset: COIN\nAmount: ${body.amount}\nI control the source Bitcoin address and authorize minting this deposit to the receive address above.`;
    body.binding_sig = bip.Signer.sign(btcKey.toWIF(), btcSource, msg); return body;
  };
  async function redeem(extra = {}, signer = owner) {
    const body = { tick: 'COIN', amount: '10', chain: 'base', to: btcSource, burn_txid: burnId, ...extra };
    body.auth_sig = await signer.signMessage(`StampySwap redeem: burn ${body.burn_txid} → release ${body.amount} to ${body.to}`); return body;
  }
  const move = extra => ({ tick: 'COIN', amount: '10', from_chain: 'base', to_chain: 'ethereum', burn_txid: burnId, to_address: owner.address, ...extra });
  return { db, state, call, claim, redeem, move, evm, context };
}


test('FIXED containment baseline: canonical path returns 503 with no effects', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/custody/verify-deposit', f.claim())).code, 503);
  assert.equal(f.state.mints.length, 0);
});
test('FIXED F01 core: public custody request without burn is rejected', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/api/custody/redeem/', { tick: 'COIN', amount: '10', to: btcSource, chain: 'base' })).code, 401);
  assert.equal(f.state.releases.length, 0);
});
test('FIXED owner check: real signature from another wallet is rejected', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem({}, attacker))).code, 401);
  assert.equal(f.state.releases.length, 0);
});
test('FIXED new burn deduplication: valid owner succeeds, uppercase replay fails', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem())).code, 200);
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem({ burn_txid: burnId.toUpperCase() }))).code, 409);
  assert.equal(f.state.releases.length, 1);
});
test('CONTAINED F04: public XCP claims remain operator-only with maintenance disabled', async t => {
  const f = await fixture(t, { maintenance: false, protocol: 'counterparty', decimals: 0, collateral: '0', circulating: '0' });
  assert.equal((await f.call('/api/custody/verify-deposit/', f.claim({ amount: '101' }))).code, 403);
  assert.equal(f.state.mints.length, 0);
});
test('CONTAINED F05: public move rejected; operator path still lacks holder authorization', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/API/MOVE', f.move({ to_address: attacker.address }))).code, 403);
  assert.equal((await f.call('/api/move', f.move({ to_address: attacker.address }), op)).code, 200);
  assert.equal(f.state.mints[0].recipient, attacker.address);
});
test('FIXED F09: excess source precision rejected before any credit', async t => {
  const f = await fixture(t, { maintenance: false, protocol: 'acme', decimals: 0, collateral: '0', circulating: '0' });
  assert.equal((await f.call('/api/custody/verify-deposit/', f.claim({ amount: '1.9' }))).code, 400);
  assert.equal(f.state.mints.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM collateral_ledger').get().n, 0);
});
test('FIXED F08 claim-loss guard: unsupported Base mainnet leaves no credit', async t => {
  const f = await fixture(t, { maintenance: false, collateral: '0', circulating: '0' });
  assert.equal((await f.call('/api/custody/verify-deposit/', f.claim({ chain: 'base-mainnet' }))).code, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM collateral_ledger').get().n, 0);
});
test('OPEN F07 (operator omits op_key): successful mint plus failed ledger update still permits duplicate retry', async t => {
  const f = await fixture(t, { maintenance: false, collateral: '10', circulating: '0' });
  const req = { tick: 'COIN', amount: '10', chain: 'base', receive_address: owner.address };
  f.state.failDb = true;
  assert.equal((await f.call('/api/mint', req, op)).code, 500);
  assert.equal((await f.call('/api/mint', req, op)).code, 200);
  assert.equal(f.state.mints.length, 2);
});
test('OPEN R04: owner-authorized partial redeem consumes full burn entitlement', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem({ amount: '1' }))).code, 200);
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem({ amount: '9' }))).code, 409);
  assert.equal(f.state.releases[0].amount, '1');
});
test('OPEN F10: partial stamp claim still consumes victim full burn when enabled', async t => {
  const f = await fixture(t, { maintenance: false });
  f.db.exec("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',1,'burn-address',1)");
  f.state.src = { ...f.state.src, destination: 'burn-address', amt: '100' };
  const req = { src20_tick: 'COIN', amount: '1', burn_txid: 'stamp-burn', user_address: btcSource };
  assert.equal((await f.call('/api/stampbridge/execute/', req)).code, 200);
  assert.equal((await f.call('/api/stampbridge/execute/', { ...req, amount: '100' })).code, 409);
  assert.equal(f.state.releases[0].amount, '1');
});
test('FIXED shared registry: a freshly redeemed burn cannot also authorize a move', async t => {
  const f = await fixture(t, { maintenance: false });
  assert.equal((await f.call('/api/custody/redeem/', await f.redeem())).code, 200);
  assert.equal((await f.call('/api/move', f.move(), op)).code, 409);
  assert.equal(f.state.mints.length, 0);
});
test('FIXED signature binding: tampering with BTC destination invalidates authorization', async t => {
  const f = await fixture(t, { maintenance: false });
  const req = await f.redeem(); req.to = 'different-destination';
  assert.equal((await f.call('/api/custody/redeem/', req)).code, 401);
  assert.equal(f.state.releases.length, 0);
});
test('FIXED F09 positive case: exact indivisible amount remains accepted', async t => {
  const f = await fixture(t, { maintenance: false, protocol: 'acme', decimals: 0, collateral: '0', circulating: '0' });
  assert.equal((await f.call('/api/custody/verify-deposit/', f.claim({ amount: '1.0' }))).code, 200);
  assert.equal(f.state.mints[0].amountToken, '1.0');
});
test('OPEN UI regression: existing redemption form never sends the newly required burn/signature', async t => {
  const f = await fixture(t, { maintenance: false });
  f.db.exec("UPDATE representations SET dest_chain='solana'");
  const fields = { '#rr-tick': { value: 'COIN' }, '#rr-amount': { value: '10' }, '#rr-to': { value: btcSource }, '#rr-out': { innerHTML: '' } };
  let submitted, response;
  const context = vm.createContext({ $: id => fields[id], esc: String, loadReserves2() {}, fetch: async (_url, args) => {
    submitted = JSON.parse(args.body); response = await f.call('/api/custody/redeem', submitted);
    return { json: async () => response.body };
  } });
  const html = read('public/index.html');
  const code = html.slice(html.indexOf('async function doRealRedeem(){'), html.indexOf("$('#rd-verify').addEventListener"));
  vm.runInContext(code, context); await vm.runInContext('doRealRedeem()', context);
  assert.equal(submitted.burn_txid, undefined); assert.equal(submitted.auth_sig, undefined);
  assert.equal(response.code, 401);
});

test('FIXED R01: maintenance blocks write URL variants before effects', async t => {
  const f = await fixture(t);
  for (const url of ['/api/custody/verify-deposit', '/API/CUSTODY/VERIFY-DEPOSIT', '/api/custody/verify-deposit/', '/api//custody/verify-deposit', '/api/custody/verify-deposit?x=1']) {
    assert.equal((await f.call(url, f.claim())).code, 503, url);
  }
  assert.equal(f.state.mints.length, 0);
});

test('FIXED legacy retirement: preview and operator cannot mutate deposit identity', async t => {
  const f = await fixture(t, { maintenance: false, preview: true });
  for (const url of ['/api/redeem', '/API/REDEEM/', '/api/preview/confirm-deposit', '/api/bridge/intent', '/API/BRIDGE/INTENT/1/TXID/']) {
    assert.equal((await f.call(url, {}, op)).code, 410, url);
  }
  assert.equal((await f.call('/API/BRIDGE/INTENT/1/')).code, 410);
});

test('FIXED schema gate: operator cannot bypass unready schema with maintenance off', async t => {
  const f = await fixture(t, { maintenance: false });
  vm.runInContext('SCHEMA_OK = false', f.context);
  assert.equal((await f.call('/api/mint', { tick:'COIN', amount:'1', receive_address:owner.address, chain:'base' }, op)).code, 503);
  assert.equal(f.state.mints.length, 0);
});

test('FIXED readiness ordering: failed historical backfill leaves writes closed', async t => {
  const f = await fixture(t, { maintenance: false });
  vm.runInContext("SCHEMA_OK = false; dbExec = async () => { throw Error('offline backfill failure') }", f.context);
  await vm.runInContext('migrateSchema()', f.context);
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), false);
  assert.equal((await f.call('/api/mint', {}, op)).code, 503);
});

test('FIXED R02 redeem: unknown broadcast retains burn and blocks another release', async t => {
  const f = await fixture(t, { maintenance: false });
  f.state.ambiguousRelease = true;
  const request = await f.redeem();
  assert.equal((await f.call('/api/custody/redeem', request)).code, 502);
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n, 1);
  assert.equal(f.db.prepare("SELECT status FROM collateral_ledger WHERE direction='redeem'").get().status, 'reconcile');
  assert.equal((await f.call('/api/custody/redeem', request)).code, 409);
  assert.equal(f.state.releases.length, 1);
});

test('FIXED historical move replay: startup backfills move-out burn before serving writes', async t => {
  const f = await fixture(t, { maintenance: false });
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'burned')").run(burnId);
  await vm.runInContext('migrateSchema()', f.context);
  assert.equal((await f.call('/api/custody/redeem', await f.redeem())).code, 409);
  assert.equal(f.state.releases.length, 0);
});

test('FIXED R06 depth gate: one-confirmation Base burn rejected, three accepted', async t => {
  const f = await fixture(t, { maintenance: false });
  f.state.head = 10;
  const request = await f.redeem();
  const shallow = await f.call('/api/custody/redeem', request);
  assert.equal(shallow.code, 409); assert.match(shallow.body.reason, /1\/3 confirmations/);
  assert.equal(f.state.releases.length, 0);
  f.state.head = 12;
  assert.equal((await f.call('/api/custody/redeem', request)).code, 200);
});

test('FIXED F07 same operation: explicit op_key stops retry after landed mint and DB failure', async t => {
  const f = await fixture(t, { collateral:'10', circulating:'0' });
  const request = { tick:'COIN', amount:'10', chain:'base', receive_address:owner.address, op_key:'mint-one' };
  f.state.failDb = true;
  assert.equal((await f.call('/api/mint', request, op)).code, 500);
  const retry = await f.call('/api/mint', request, op);
  assert.equal(retry.code, 409); assert.equal(retry.body.reconcile, true);
  assert.equal(f.state.mints.length, 1);
});

test('FIXED R07 maintenance: wrap availability and custody deposits disabled', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/wrap/route?asset=COIN')).body.enabled, false);
  assert.equal((await f.call('/api/custody/status')).body.deposits_live, false);
});

test('OPEN R05 stamp release: unknown broadcast still permits a second release', async t => {
  const f = await fixture(t, { maintenance: false });
  f.db.exec("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',1,'burn-address',1)");
  f.state.src = { ...f.state.src, destination:'burn-address', amt:'10' };
  const request = { src20_tick:'COIN', amount:'10', burn_txid:'stamp-burn', user_address:btcSource };
  f.state.ambiguousRelease = true;
  assert.equal((await f.call('/api/stampbridge/execute', request)).code, 502);
  assert.equal(f.db.prepare('SELECT count(*) n FROM bridge_ops').get().n, 0);
  assert.equal((await f.call('/api/stampbridge/execute', request)).code, 200);
  assert.equal(f.state.releases.length, 2);
});

test('OPEN R03 schema gate: missing primary keys still declared ready', async t => {
  const f = await fixture(t);
  f.db.exec(`DROP TABLE operations; DROP TABLE consumed_burns;
    CREATE TABLE operations(op_key TEXT, action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT, state TEXT, created_at INTEGER, updated_at INTEGER, tx_id TEXT, result_json TEXT);
    CREATE TABLE consumed_burns(burn_txid TEXT, chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER);`);
  vm.runInContext('SCHEMA_OK = false', f.context);
  await vm.runInContext('migrateSchema()', f.context);
  assert.equal(vm.runInContext('SCHEMA_OK', f.context), true);
  const meta = { action:'mint', canonical_id:1, amount:'1', chain:'base', recipient:owner.address };
  assert.equal((await f.context.opReserve('same-key', meta)).fresh, true);
  assert.equal((await f.context.opReserve('same-key', meta)).fresh, true);
});
