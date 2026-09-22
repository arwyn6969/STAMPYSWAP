// Handler-level PREVENTION tests (audit 457dc9a, findings A01/A03/A05/A06).
//
// Adapted from the independent auditor's whole-server harness, but pointed at THIS repo's current
// server.js (no source-hash pin) and asserting the INTENDED behaviour — so these go green only when
// the recovery fixes hold, and would fail on the pre-fix code. Real Express routing + real
// EIP-191/BIP-322 verification; all chain/indexer/DB effects are local fixtures, no vault keys.
//
// Requires node:sqlite → run with:  node --experimental-sqlite --test test/handler.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const { createRequire } = require('node:module')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..')
const dep = createRequire(path.join(ROOT, 'package.json'))
const expressReal = dep('express')
const { ethers } = dep('ethers')
const bip = dep('bip322-js')
const bitcoin = dep('bitcoinjs-lib')
const btcKey = dep('ecpair').ECPairFactory(dep('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 7))
const btcSource = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(btcKey.publicKey) }).address
const owner = new ethers.Wallet('0x' + '1'.repeat(64))
const attacker = new ethers.Wallet('0x' + '2'.repeat(64))
const token = '0x' + '3'.repeat(40)
const burnId = '0x' + 'ab'.repeat(32)
const op = { 'x-operator-token': 'local-fixture-operator' }
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

function load(file, req, globals = {}) {
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, require: req,
    __dirname: ROOT, process: { env: {} }, console: { log() {}, error() {} }, Buffer,
    AbortController, TextEncoder, setTimeout, clearTimeout, ...globals })
  vm.runInContext(read(file), context, { filename: file })
  return { exports: module.exports, context }
}

async function fixture(t, options = {}) {
  const { protocol = 'src-20', decimals = 8, collateral = '100', circulating = '100', maintenance = false } = options
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE canonical_assets(id INTEGER PRIMARY KEY, exact_ticker TEXT, source_protocol TEXT, max_supply TEXT, decimals INTEGER, whitelisted INTEGER, deploy_tx TEXT);
    CREATE TABLE representations(id INTEGER PRIMARY KEY, canonical_id INTEGER, dest_chain TEXT, dest_address TEXT, circulating_supply TEXT, status TEXT, updated_at INTEGER, dest_symbol TEXT, authority_model TEXT);
    CREATE TABLE collateral_ledger(id INTEGER PRIMARY KEY, canonical_id INTEGER, direction TEXT, amount TEXT, dest_chain TEXT, btc_txid TEXT UNIQUE, burn_txid TEXT, vault_address TEXT, confirmations INTEGER, status TEXT, created_at INTEGER, dest_tx TEXT);
    CREATE TABLE consumed_burns(burn_txid TEXT PRIMARY KEY, chain TEXT, canonical_id INTEGER, purpose TEXT, owner TEXT, amount TEXT, created_at INTEGER);
    CREATE TABLE stamp_bridges(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, stamp_protocol TEXT, ratio INTEGER, burn_address TEXT, enabled INTEGER);
    CREATE TABLE bridge_ops(id INTEGER PRIMARY KEY, src20_tick TEXT, stamp_asset TEXT, amount TEXT, burn_txid TEXT UNIQUE, user_address TEXT, release_txid TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE operations(op_key TEXT PRIMARY KEY, action TEXT, canonical_id INTEGER, amount TEXT, chain TEXT, recipient TEXT, state TEXT, created_at INTEGER, updated_at INTEGER, tx_id TEXT, result_json TEXT);
    CREATE TABLE pools(id INTEGER PRIMARY KEY, canonical_a INTEGER, canonical_b INTEGER);
  `)
  db.prepare('INSERT INTO canonical_assets VALUES (1,?,?,?,?,1,?)').run('COIN', protocol, '1000000', decimals, 'deploy')
  db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply,status) VALUES(1,1,'base',?,?,'CANONICAL')").run(token, circulating)
  if (collateral !== '0') db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit',?,'initial','confirmed')").run(collateral)
  const state = { releases: [], mints: [], failDb: false, vaultBalance: '101',
    sends: [{ source: btcSource, destination: 'vault', status: 'valid', quantity: '1', tx_hash: 'deposit', block_index: 10 }],
    src: { op: 'TRANSFER', tick: 'COIN', creator: btcSource, destination: 'vault', amt: '10', block_index: 10 },
    receipt: { status: 1, blockNumber: 10, logs: [{ address: token,
      topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash],
      data: ethers.toBeHex(ethers.parseUnits('10', 18), 32) }] } }
  const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) })
  async function fetchFixture(url) {
    const u = new URL(url)
    if (u.pathname.startsWith('/api/v2/src20/tx/')) return json({ data: { ...state.src, tx_hash: decodeURIComponent(u.pathname.split('/').pop()) }, last_block: 30 })
    if (u.pathname.endsWith('/balances')) return json({ result: ['COIN', 'STAMP'].map(asset => ({ asset, quantity: state.vaultBalance })) })
    if (u.pathname.endsWith('/sends')) return json({ result: state.sends })
    if (u.pathname.endsWith('/blocks/last')) return json({ result: { block_index: 30 } })
    throw Error('External request blocked: ' + url)
  }
  const pure = file => load(file, () => { throw Error('unexpected import') }, { fetch: fetchFixture }).exports
  const cp = pure('counterparty.js'), acme = pure('acme.js')
  const evm = load('evm-mint.js', n => {
    if (n === 'ethers') return { ethers }
    if (n === './evm-signer') return { address: attacker.address, provider: () => ({ getTransactionReceipt: async () => state.receipt, getBlockNumber: async () => state.head || 30 }) }
    if (n === './erc20-artifact.json') return JSON.parse(read('erc20-artifact.json'))
    throw Error('unexpected import: ' + n)
  }).exports
  evm.deployAndMint = async args => { state.mints.push(args); return { contract: token, txHash: 'mint-' + state.mints.length } }
  const custody = { depositAddress: async () => 'vault', isLive: () => true, status: async () => ({ deposits_live: true, live: true }),
    redeem: async args => { state.releases.push(args); return { released: true, txid: 'release-' + state.releases.length } } }
  let app
  function express() { app = expressReal(); app.listen = () => {}; return app }
  Object.assign(express, expressReal)
  const dependencies = { express, path, crypto: require('node:crypto'), tweetnacl: dep('tweetnacl'),
    bs58: dep('bs58'), './sol-mint': {}, './evm-mint': evm, './amm': {}, './custody': custody,
    './recovery': require(path.join(ROOT, 'recovery.js')), './labels': require(path.join(ROOT, 'labels.js')),
    './counterparty': cp, './acme': acme, './prices': {}, './squads': null, './safe': null,
    'bip322-js': bip, fs: { existsSync: () => false }, ethers }
  const query = async (sql, params = []) => db.prepare(sql).all(...params)
  const exec = async (sql, params = []) => {
    if (state.failDb && sql.startsWith('UPDATE representations')) { state.failDb = false; throw Error('fixture DB failure after effect') }
    return db.prepare(sql).run(...params)
  }
  const { context } = load('server.js', n => {
    if (!(n in dependencies)) throw Error('Unexpected import: ' + n); return dependencies[n]
  }, { fetch: fetchFixture, process: { env: { OPERATOR_TOKEN: op['x-operator-token'], STAMPY_MAINTENANCE: maintenance ? '1' : '0', STAMPY_PREVIEW: '0' } },
    setInterval: () => ({ unref() {} }), __query: query, __exec: exec })
  vm.runInContext('dbQuery = __query; dbExec = __exec', context)
  await new Promise(setImmediate) // let the (intentionally disconnected) startup schema check settle
  await vm.runInContext('migrateSchema()', context)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close() })
  async function call(url, body, headers = {}) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { code: r.status, body: await r.json() }
  }
  async function redeem(extra = {}, signer = owner) {
    const body = { tick: 'COIN', amount: '10', chain: 'base', to: btcSource, burn_txid: burnId, ...extra }
    body.auth_sig = await signer.signMessage(`StampySwap redeem: burn ${body.burn_txid} → release ${body.amount} to ${body.to}`)
    return body
  }
  const claim = (extra = {}) => {
    const body = { tick: 'COIN', amount: '10', txid: 'deposit', chain: 'base', receive_address: attacker.address, source_address: btcSource, ...extra }
    const msg = `StampySwap deposit authorization\nSource: ${btcSource}\nReceive: ${body.receive_address}\nAsset: COIN\nAmount: ${body.amount}\nI control the source Bitcoin address and authorize minting this deposit to the receive address above.`
    body.binding_sig = bip.Signer.sign(btcKey.toWIF(), btcSource, msg)
    return body
  }
  const circ = () => db.prepare('SELECT circulating_supply c FROM representations WHERE id=1').get().c
  const move = extra => ({ tick: 'COIN', amount: '10', from_chain: 'base', to_chain: 'ethereum', burn_txid: burnId, to_address: owner.address, ...extra })
  return { db, state, call, redeem, claim, move, circ }
}

// ---------------------------------------------------------------------------------------------------

test('A01: repeated release reconciliation decrements circulation at most once', async t => {
  const f = await fixture(t, { circulating: '100', collateral: '100' })
  // a redeem that reserved then went 'reconcile' (uncertain broadcast)
  f.db.prepare("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(50,1,'redeem','10','base','rb','reconcile')").run()
  const r1 = await f.call('/api/reconcile', { kind: 'redeem', id: 50, resolution: 'released', release_txid: 'rt' }, op)
  const r2 = await f.call('/api/reconcile', { kind: 'redeem', id: 50, resolution: 'released', release_txid: 'rt' }, op)
  assert.equal(r1.code, 200)
  assert.equal(r2.code, 409)        // already terminal — not re-decremented
  assert.equal(f.circ(), '90')      // decremented exactly ONCE (the bug decremented to 80)
})

test('A01: a lost decrement write leaves circulation too HIGH (fail-closed), never doubled', async t => {
  const f = await fixture(t, { circulating: '100', collateral: '100' })
  f.db.prepare("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(51,1,'redeem','10','base','rb','reconcile')").run()
  f.state.failDb = true // the circulation UPDATE throws AFTER the terminal status flip
  const r1 = await f.call('/api/reconcile', { kind: 'redeem', id: 51, resolution: 'released', release_txid: 'rt' }, op)
  assert.equal(r1.code, 500)                     // surfaced, not swallowed
  const r2 = await f.call('/api/reconcile', { kind: 'redeem', id: 51, resolution: 'released', release_txid: 'rt' }, op)
  assert.equal(r2.code, 409)                     // row already terminal
  assert.equal(f.circ(), '100')                  // NEVER decremented twice; stays high = never over-mints
})

test('A03: a completed deposit-mint op resolves as done and never deletes the backing', async t => {
  const f = await fixture(t, { collateral: '10', circulating: '0' })
  // a peer worker already credited + minted this deposit (op completed); the credit backs the mint
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit','10','deposit','confirmed')").run()
  f.db.prepare("INSERT INTO operations(op_key,action,canonical_id,amount,chain,recipient,state,result_json) VALUES('deposit-mint:deposit','mint',1,'10','base',?,'completed','{\"minted\":true}')").run(attacker.address)
  const before = f.db.prepare("SELECT count(*) n FROM collateral_ledger WHERE btc_txid='deposit'").get().n
  const r = await f.call('/api/custody/verify-deposit', f.claim({ amount: '10' }))
  assert.equal(r.code, 409)                       // "already credited and minted" (idempotent done)
  assert.equal(f.db.prepare("SELECT count(*) n FROM collateral_ledger WHERE btc_txid='deposit'").get().n, before) // NOT deleted
})

test('A05: a move whose source-debit is unconfirmed does NOT mint on resume', async t => {
  const f = await fixture(t, { circulating: '100', collateral: '100' })
  // crash after burn-consume but before the debit was confirmed: burn consumed + move-out still 'pending'
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,owner,amount) VALUES(?,'base',1,'move',?,'10')").run(burnId, owner.address)
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'pending')").run(burnId)
  const r = await f.call('/api/move', f.move(), op)
  assert.equal(r.code, 409)
  assert.ok(r.body.reconcile)                     // fail-closed reconcile
  assert.equal(f.state.mints.length, 0)           // NO destination mint (would have been over-issuance)
})

test('A05: a move with a confirmed source-debit resumes ONLY the destination mint', async t => {
  const f = await fixture(t, { circulating: '90', collateral: '100' }) // source already debited 10 → circ 90
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,owner,amount) VALUES(?,'base',1,'move',?,'10')").run(burnId, owner.address)
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'decremented')").run(burnId)
  const r = await f.call('/api/move', f.move(), op)
  assert.equal(r.code, 200)
  assert.equal(f.state.mints.length, 1)           // dest mint driven exactly once, no re-debit
})

test('A06: operator mint without an op_key is rejected before any effect', async t => {
  const f = await fixture(t, { collateral: '100', circulating: '0' })
  const r = await f.call('/api/mint', { tick: 'COIN', amount: '1', receive_address: owner.address, chain: 'base' }, op)
  assert.equal(r.code, 400)
  assert.equal(f.state.mints.length, 0)
})

test('F05: a non-operator move requires the burn-owner signature (front-run resistant)', async t => {
  const f = await fixture(t, { circulating: '100', collateral: '100' })
  const sig = signer => signer.signMessage(`StampySwap move: burn ${burnId} → mint 10 on ethereum to ${owner.address}`)
  // no signature → 401 with the exact binding message, nothing consumed/minted
  const noSig = await f.call('/api/move', f.move())
  assert.equal(noSig.code, 401)
  assert.ok(noSig.body.binding_message)
  assert.equal(f.state.mints.length, 0)
  // wrong signer (attacker) → 401, still nothing consumed
  const bad = f.move(); bad.auth_sig = await sig(attacker)
  assert.equal((await f.call('/api/move', bad)).code, 401)
  assert.equal(f.state.mints.length, 0)
  // the real burner's signature → authorized → move completes
  const good = f.move(); good.auth_sig = await sig(owner)
  assert.equal((await f.call('/api/move', good)).code, 200)
  assert.equal(f.state.mints.length, 1)
})
