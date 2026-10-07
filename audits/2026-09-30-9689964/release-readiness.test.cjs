// Independent release-readiness evidence. OPEN tests pass when a defect is reproduced.
// Whole current server, local SQLite, mocked chain effects; never loads custody keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { fixture, owner, attacker, token, burnId, btcSource, op, read, dep, load } = require('./fixture.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const mint = (key, chain='base') => ({ tick:'COIN', amount:'10', chain, receive_address:owner.address, op_key:key });
function pendingRedeem(f, id=50) {
  f.db.prepare("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(?,1,'redeem','10','base',?,'reconcile')").run(id,burnId);
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'redeem','10')").run(burnId);
}

test('OPEN B01: expired lease can be stolen from a still-running mint and overissue backing', async t => {
  const clock = { now: 1000000 }; const entered = deferred(); const resume = deferred();
  const a = await fixture(t, { collateral:'10', circulating:'0', clock,
    async beforeMint() { entered.resolve(); await resume.promise; } });
  const b = await fixture(t, { db:a.db, clock });
  const first = a.call('/api/mint',mint('lease-A'),op);
  await entered.promise; // A holds lock, has passed solvency, waiting on its signer/RPC
  clock.now += 31000; // real protocol lease is 30 s; clock advancement avoids a wall-clock sleep
  const second = await b.call('/api/mint',mint('lease-B'),op);
  assert.equal(second.code,200);
  resume.resolve(); assert.equal((await first).code,200);
  assert.equal(a.state.mints.length+b.state.mints.length,2);
  assert.equal(a.circ(),'20');
  assert.equal(await a.context.collateralBase(1),10n*10n**18n);
});

test('OPEN B02: committed debit plus lost DB response is retried and decrements twice', async t => {
  let once=true;
  const f=await fixture(t,{afterExec(sql) {
    if(once && sql.startsWith('UPDATE representations SET circulating_supply=')) {
      once=false; throw Error('DB committed the decrement; HTTP response was lost');
    }
  }});
  pendingRedeem(f);
  const result=await f.call('/api/reconcile',{kind:'redeem',id:50,resolution:'released',release_txid:'release'},op);
  assert.equal(result.code,200); assert.equal(f.circ(),'80'); // actual post-burn supply is 90
  assert.equal((await f.call('/api/mint',mint('extra-ten'),op)).code,200);
  assert.equal(f.state.mints.length,1); // actual 100 issued against 90 remaining collateral
});

test('OPEN B03: failed new representation insert is swallowed and mint is marked completed',async t=>{
  let once=true;
  const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){
    if(once && sql.startsWith('INSERT INTO representations')){once=false;throw Error('insert failed before commit');}
  }});
  const first=await f.call('/api/mint',mint('new-rep-A','ethereum'),op);
  assert.equal(first.code,200);
  assert.equal(f.db.prepare("SELECT count(*) n FROM representations WHERE dest_chain='ethereum'").get().n,0);
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='new-rep-A'").get().state,'completed');
  assert.equal((await f.call('/api/mint',mint('new-rep-B','ethereum'),op)).code,200);
  assert.equal(f.state.mints.length,2); // two external effects, only 10 issued units recorded
  assert.equal(f.db.prepare("SELECT circulating_supply FROM representations WHERE dest_chain='ethereum'").get().circulating_supply,'10');
});

test('OPEN B04: uncertain mint does not reserve its potential issuance against a different operation',async t=>{
  let once=true;
  const f=await fixture(t,{collateral:'10',circulating:'0',afterMint(){
    if(once){once=false;throw Error('mint accepted; RPC response lost');}
  }});
  assert.equal((await f.call('/api/mint',mint('unknown-A'),op)).code,502);
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='unknown-A'").get().state,'reconcile');
  assert.equal(f.circ(),'0');
  assert.equal((await f.call('/api/mint',mint('different-B'),op)).code,200);
  assert.equal(f.state.mints.length,2); assert.equal(f.circ(),'10');
});

test('OPEN B05: persistent decrement failure reports successful terminal reconciliation',async t=>{
  const f=await fixture(t,{beforeExec(sql){if(sql.startsWith('UPDATE representations SET circulating_supply='))throw Error('persistent DB failure');}});
  pendingRedeem(f);
  const r=await f.call('/api/reconcile',{kind:'redeem',id:50,resolution:'released',release_txid:'release'},op);
  assert.equal(r.code,200); assert.equal(r.body.finalized,true); assert.equal(f.circ(),'100');
  assert.equal((await f.call('/api/reconcile',{kind:'redeem',id:50,resolution:'released'},op)).code,409);
  const inventory=await f.call('/api/reconcile',undefined,op);
  assert.equal(inventory.body.stuck_redeems.length,0); // inconsistent row vanished from repair inventory
});

test('OPEN B05: failed source debit can still be marked decremented and move reports success',async t=>{
  const f=await fixture(t,{collateral:'200',circulating:'100',beforeExec(sql,params){
    if(sql.startsWith('UPDATE representations SET circulating_supply=') && params[2]===1)throw Error('persistent debit failure');
  }});
  const r=await f.call('/api/move',f.move(),op);
  assert.equal(r.code,200); assert.equal(f.circ(),'100');
  assert.equal(f.db.prepare("SELECT status FROM collateral_ledger WHERE direction='move-out'").get().status,'decremented');
  assert.equal(f.state.mints.length,1);
});

test('OPEN B06: restart reconsumes an explicitly aborted move burn',async t=>{
  const f=await fixture(t);
  f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'move','10')").run(burnId);
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'pending')").run(burnId);
  assert.equal((await f.call('/api/reconcile',{kind:'move',burn_txid:burnId,resolution:'aborted'},op)).code,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
  await f.context.migrateSchema();
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,1);
  assert.equal((await f.call('/api/move',f.move(),op)).body.reconcile,true);
});

test('OPEN B07: asset_locks without uniqueness is accepted and admits two holders',async t=>{
  const f=await fixture(t);
  f.db.exec('DROP TABLE asset_locks; CREATE TABLE asset_locks(asset_id INTEGER,holder TEXT,acquired_at INTEGER,expires_at INTEGER)');
  vm.runInContext('SCHEMA_OK=false',f.context); await f.context.migrateSchema();
  assert.equal(vm.runInContext('SCHEMA_OK',f.context),true);
  await f.context.acquireAssetLock(1); await f.context.acquireAssetLock(1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM asset_locks').get().n,2);
});

test('OPEN B07: irrelevant partial unique index passes the operation uniqueness gate',async t=>{
  const f=await fixture(t);
  f.db.exec(`DROP TABLE operations;
    CREATE TABLE operations(op_key TEXT,action TEXT,canonical_id INTEGER,amount TEXT,chain TEXT,recipient TEXT,state TEXT,created_at INTEGER,updated_at INTEGER,tx_id TEXT,result_json TEXT);
    CREATE UNIQUE INDEX only_completed ON operations(op_key) WHERE state='completed';`);
  vm.runInContext('SCHEMA_OK=false',f.context); await f.context.migrateSchema();
  assert.equal(vm.runInContext('SCHEMA_OK',f.context),true);
  const m={action:'mint',canonical_id:1,amount:'10',chain:'base',recipient:owner.address};
  assert.equal((await f.context.opReserve('same',m)).fresh,true);
  assert.equal((await f.context.opReserve('same',m)).fresh,true);
});

test('OPEN B06: NULL-status historical redemption is omitted from burn backfill',async t=>{
  const f=await fixture(t);
  f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(1,'redeem','10','base',?,NULL)").run(burnId);
  await f.context.migrateSchema();
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
  assert.equal((await f.call('/api/custody/redeem',await f.redeem())).code,200);
  assert.equal(f.state.releases.length,1);
});

test('OPEN B08: withdrawal and move UI omit required authorizations',async t=>{
  const f=await fixture(t); const html=read('public/index.html');
  const fields={'#rr-tick':{value:'COIN'},'#rr-amount':{value:'10'},'#rr-to':{value:btcSource},'#rr-out':{innerHTML:''},
    '#mv-asset':{value:'COIN'},'#mv-amount':{value:'10'},'#mv-from':{value:'base'},'#mv-to':{value:'ethereum'},'#mv-txid':{value:burnId},'#mv-toaddr':{value:owner.address},'#mv-out':{innerHTML:''}};
  let request,response;
  const ui=vm.createContext({$:s=>fields[s],esc:String,loadReserves2(){},fetch:async(url,args)=>{
    request=JSON.parse(args.body);response=await f.call('/'+url,request);return {json:async()=>response.body};
  }});
  vm.runInContext(html.slice(html.indexOf('async function doRealRedeem(){'),html.indexOf("$('#rd-verify').addEventListener")),ui);
  f.db.exec("UPDATE representations SET dest_chain='solana'"); // UI hard-codes Solana; give it an eligible representation
  await vm.runInContext('doRealRedeem()',ui);
  assert.equal(request.burn_txid,undefined); assert.equal(request.auth_sig,undefined);assert.equal(response.code,401);
  f.db.exec("UPDATE representations SET dest_chain='base'");
  const start=html.indexOf('async function doMove(){');
  vm.runInContext(html.slice(start,html.indexOf('\n}',start)+2),ui);
  await vm.runInContext('doMove()',ui);
  assert.equal(request.auth_sig,undefined);assert.equal(response.code,401);
});

test('OPEN B09: SRC-20 output guard permits an excessive miner fee and no transfer payload',async()=>{
  const bitcoin=dep('bitcoinjs-lib'); const from=btcSource;
  const p=new bitcoin.Psbt({network:bitcoin.networks.bitcoin});
  p.addInput({hash:'11'.repeat(32),index:0,witnessUtxo:{script:bitcoin.address.toOutputScript(from),value:1000000}});
  p.addOutput({address:from,value:546}); // 999454 sat fee; no SRC-20 payload or recipient output
  let signed=0;
  const c=load('custody.js',n=>{
    if(n==='@emblemvault/auth-sdk/signers/bitcoin')return {fetchBitcoinVaultInfo:async()=>({btcAddresses:{p2wpkh:from}}),toBitcoinSigner:async()=>({signPsbt:async()=>{signed++;return {signedTxHex:'00'};}})};
    if(n==='bitcoinjs-lib')return bitcoin;
    if(n==='fs')return {existsSync:()=>false};
    if(n==='path')return require('node:path');
    if(n==='./acme')return null;
    throw Error('unexpected dependency '+n);
  },{process:{env:{STAMPY_CUSTODY_LIVE:'1'}},fetch:async url=>url.includes('/src20/create')
    ?{ok:true,json:async()=>({hex:p.toHex(),inputsToSign:[{index:0,sighashType:1}]})}
    :{ok:true,text:async()=>'aa'.repeat(32)}}).exports;
  const recipient=bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,9)}).address;
  const r=await c.redeem({tick:'COIN',amount:'10',toAddress:recipient});
  assert.equal(signed,1);assert.equal(r.released,true);
});

test('FIXED A02: legacy mint key blocks a possibly repeated deposit mint',async t=>{
  const f=await fixture(t,{collateral:'0',circulating:'0'});
  f.db.exec("INSERT INTO collateral_ledger(canonical_id,direction,amount,btc_txid,status) VALUES(1,'deposit','10','deposit','confirmed')");
  f.db.prepare("INSERT INTO operations(op_key,state,recipient) VALUES(?,'reserved',?)").run('deposit-mint:deposit:base:'+attacker.address,attacker.address);
  const r=await f.call('/api/custody/verify-deposit',f.claim());
  assert.equal(r.code,409);assert.equal(r.body.reconcile,true);assert.equal(f.state.mints.length,0);
});

test('FIXED A04: successful failed-redeem reconciliation stays freed across startup',async t=>{
  const f=await fixture(t);pendingRedeem(f);
  assert.equal((await f.call('/api/reconcile',{kind:'redeem',id:50,resolution:'failed'},op)).code,200);
  await f.context.migrateSchema();
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
});

test('FIXED A07: ambiguous stamp broadcast retains reservation and blocks second release',async t=>{
  const f=await fixture(t,{afterRelease(){throw Error('accepted release; response lost');}});
  f.db.exec("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',1,'burn-address',1)");
  f.state.src={...f.state.src,destination:'burn-address',amt:'10'};
  const request={src20_tick:'COIN',amount:'10',burn_txid:'stampburn',user_address:btcSource};
  assert.equal((await f.call('/api/stampbridge/execute',request)).code,502);
  assert.equal((await f.call('/api/stampbridge/execute',request)).code,409);
  assert.equal(f.state.releases.length,1);
});

test('FIXED R04 and F10: partial representation and stamp claims rejected without consuming entitlement',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/custody/redeem',await f.redeem({amount:'1'}))).code,409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
  f.db.exec("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',1,'burn-address',1)");
  f.state.src={...f.state.src,destination:'burn-address',amt:'10'};
  assert.equal((await f.call('/api/stampbridge/execute',{src20_tick:'COIN',amount:'1',burn_txid:'stampburn',user_address:btcSource})).code,409);
  assert.equal(f.state.releases.length,0);
});

test('FIXED containment: path variants, schema failure and retired routes remain closed',async t=>{
  const f=await fixture(t,{maintenance:true});
  for(const url of ['/api/custody/verify-deposit','/API/CUSTODY/VERIFY-DEPOSIT/','/api//custody/verify-deposit'])assert.equal((await f.call(url,f.claim())).code,503);
  for(const url of ['/api/redeem','/API/BRIDGE/INTENT/1/TXID/'])assert.equal((await f.call(url,{},op)).code,410);
  vm.runInContext('SCHEMA_OK=false',f.context);
  assert.equal((await f.call('/api/mint',mint('unready'),op)).code,503);
});

test('FIXED F09 and ACME regression: exact indivisible claim succeeds, extra precision fails before mint',async t=>{
  const f=await fixture(t,{protocol:'acme',decimals:0,collateral:'0',circulating:'0'});
  f.state.sends=[{source:btcSource,destination:'vault',status:'valid',quantity:'10',tx_hash:'acmedep',block_index:10}];
  assert.equal((await f.call('/api/custody/verify-deposit',f.claim({txid:'acmedep',amount:'10.1'}))).code,400);
  assert.equal((await f.call('/api/custody/verify-deposit',f.claim({txid:'acmedep',amount:'10'}))).code,200);
  assert.equal(f.state.mints.length,1);
});
