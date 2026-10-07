// Whole-server repair verification. All chain effects are mocked; real SQLite and HTTP routing.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { fixture, owner, token, op } = require('./audit-e.fixture.cjs');
const mint = (key, chain = 'base') => ({tick:'COIN', amount:'10', chain, receive_address:owner.address, op_key:key});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const assetRead = sql => sql.startsWith('SELECT r.id AS rep_id, e.event_key') || sql === 'SELECT delta_base FROM accounting_events WHERE rep_id=?';

test('E02: stale worker refreshes identity and reuses the peer token, never deploying a replacement', async t => {
  const clock={now:1000000}, entered=deferred(), resume=deferred(); let pause=true;
  const a=await fixture(t,{collateral:'20',circulating:'0',clock,async beforeExec(sql,params){
    if(pause && sql.startsWith('INSERT INTO operations') && params[0]==='identity-A') {pause=false;entered.resolve();await resume.promise;}
  }});
  const b=await fixture(t,{db:a.db,clock}); const contractB='0x'+'5'.repeat(40);
  a.evm.deployAndMint=async args=>{a.state.mints.push(args); return {contract:args.existingContract || ('0x'+'4'.repeat(40)),txHash:'A'};};
  b.evm.deployAndMint=async args=>{b.state.mints.push(args); return {contract:contractB,txHash:'B'};};
  const pending=a.call('/api/mint',mint('identity-A','ethereum'),op);
  await entered.promise; clock.now+=31000;
  try { assert.equal((await b.call('/api/mint',mint('identity-B','ethereum'),op)).code,200); }
  finally { resume.resolve(); }
  assert.equal((await pending).code,200);
  assert.equal(b.state.mints[0].existingContract,undefined);
  assert.equal(a.state.mints[0].existingContract,contractB);
  assert.equal(a.db.prepare("SELECT dest_address FROM representations WHERE dest_chain='ethereum'").get().dest_address,contractB);
  assert.equal(a.db.prepare("SELECT count(*) n FROM operations WHERE action='representation-deploy'").get().n,1);
});

test('E02: expired lease cannot allow a second deployment while the first external call is paused',async t=>{
  const clock={now:1000000},entered=deferred(),resume=deferred();
  const a=await fixture(t,{collateral:'20',circulating:'0',clock,async beforeMint(){entered.resolve();await resume.promise;}});
  const b=await fixture(t,{db:a.db,clock});
  const pending=a.call('/api/mint',mint('deploy-A','ethereum'),op);await entered.promise;clock.now+=31000;
  let r;
  try {r=await b.call('/api/mint',mint('deploy-B','ethereum'),op);}
  finally {resume.resolve();}
  const first=await pending;
  assert.equal(r.code,409);assert.equal(r.body.reconcile,true);assert.equal(b.state.mints.length,0);
  assert.equal(first.code,200);assert.equal(a.state.mints.length,1);
});

test('E02: ambiguous first deployment stays claimed across restart and a different mint key',async t=>{
  const f=await fixture(t,{collateral:'30',circulating:'0',afterMint(){throw Error('accepted, response lost');}});
  assert.equal((await f.call('/api/mint',mint('uncertain-deploy','ethereum'),op)).code,502);
  const reboot=await fixture(t,{db:f.db});
  assert.equal((await reboot.call('/api/mint',mint('new-deploy','ethereum'),op)).code,409);
  assert.equal(reboot.state.mints.length,0);
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE action='representation-deploy'").get().state,'reserved');
});

test('E02: incomplete registered identity blocks before any signer effect',async t=>{
  const f=await fixture(t,{collateral:'20',circulating:'0'});
  f.db.prepare('UPDATE representations SET dest_address=NULL').run();
  assert.equal((await f.call('/api/mint',mint('missing-address'),op)).code,503);assert.equal(f.state.mints.length,0);
});

for(const envelope of [{},{error:'unavailable'},{rows:null},{rows:{}},{rows:[null]},{rows:[[]]},{rows:[{}]},{rows:[],error:'failed'},{success:false,rows:[]}]) {
  test('E03: invalid query envelope refuses mint: '+JSON.stringify(envelope),async t=>{
    const f=await fixture(t,{collateral:'10',circulating:'10'});
    f.context.fetch=async url=>{ const u=new URL(url),sql=u.searchParams.get('sql'),params=JSON.parse(u.searchParams.get('params')||'[]');
      return {ok:true,json:async()=>assetRead(sql)?envelope:{rows:f.db.prepare(sql).all(...params)}};
    };
    vm.runInContext('dbQuery=originalDbQuery',f.context);
    assert.equal((await f.call('/api/mint',mint('bad-envelope'),op)).code,503);assert.equal(f.state.mints.length,0);
  });
}

for(const target of ['events','reservations']) {
  test('E03: malformed liabilities retain backing and prevent a second mint: '+target,async t=>{
    const f=await fixture(t,{collateral:'10',circulating:target==='events'?'10':'0',afterMint(){if(target==='reservations')throw Error('accepted, response lost');}});
    if(target==='reservations')assert.equal((await f.call('/api/mint',mint('uncertain-http'),op)).code,502);
    f.context.fetch=async url=>{const u=new URL(url),sql=u.searchParams.get('sql'),params=JSON.parse(u.searchParams.get('params')||'[]');
      const selected=target==='events'?assetRead(sql):sql.startsWith('SELECT op_key, amount FROM operations');
      return {ok:true,json:async()=>selected?{error:'unavailable'}:{rows:f.db.prepare(sql).all(...params)}};
    };
    vm.runInContext('dbQuery=originalDbQuery',f.context);
    assert.equal((await f.call('/api/mint',mint('malformed-http'),op)).code,503);
    assert.equal(f.state.mints.length,target==='events'?0:1);
  });
}

test('E04: planner reports event liability despite stale display cache',async t=>{
  const f=await fixture(t,{collateral:'100',circulating:'100'});
  f.db.prepare("INSERT INTO accounting_events VALUES('known-mint',1,?,1)").run((10n*10n**18n).toString());
  const r=await f.call('/api/wrap/route?asset=COIN');assert.equal(r.code,200);
  assert.equal(r.body.reserves.circulating,'110');assert.equal(r.body.reserves.solvent,false);
});

test('all representations and events are read in one query snapshot, with exact precision',async t=>{
  let reads=0;
  const f=await fixture(t,{collateral:'100',circulating:'0',beforeQuery(sql){if(assetRead(sql))reads++;}});
  f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,circulating_supply) VALUES(2,1,'ethereum','0')").run();
  const n=9007199254740993000000000000000001n;
  f.db.prepare("INSERT INTO accounting_events VALUES('large',1,?,1)").run(n.toString());
  f.db.prepare("INSERT INTO accounting_events VALUES('last-unit',2,'1',1)").run();
  const initial=reads;assert.equal(await f.context.assetCirculatingBase(1),n+1n);assert.equal(reads-initial,1);
});

test('completion persistence failure reports reconciliation and never repeats the mint',async t=>{
  const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){if(sql.startsWith("UPDATE operations SET state='completed'"))throw Error('completion unavailable');}});
  const r=await f.call('/api/mint',mint('completion-failed'),op);
  assert.equal(r.code,200);assert.equal(r.body.op_completed,false);assert.equal(r.body.reconcile,true);
  assert.equal((await f.call('/api/mint',mint('completion-failed'),op)).code,409);
  assert.equal(f.state.mints.length,1);assert.equal(f.circ(),'10');
});

test('no-op completion update is detected by reading durable state back',async t=>{
  const f=await fixture(t,{collateral:'10',circulating:'0'});
  vm.runInContext("const realExec=dbExec; dbExec=(sql,params)=>sql.startsWith(\"UPDATE operations SET state='completed'\")?Promise.resolve({changes:0}):realExec(sql,params)",f.context);
  const r=await f.call('/api/mint',mint('completion-noop'),op);assert.equal(r.code,200);assert.equal(r.body.op_completed,false);assert.equal(r.body.reconcile,true);
  assert.equal(f.state.mints.length,1);
});

for(const mode of ['missing','partial','extra-column']) {
  test('representation uniqueness startup gate rejects '+mode+' constraints',async t=>{
    const f=await fixture(t,{collateral:'20',circulating:'0'});
    f.db.exec('DROP INDEX representation_identity');
    if(mode==='partial')f.db.exec("CREATE UNIQUE INDEX partial_identity ON representations(canonical_id,dest_chain) WHERE status='CANONICAL'");
    if(mode==='extra-column')f.db.exec('CREATE UNIQUE INDEX wrong_identity ON representations(canonical_id,dest_chain,dest_address)');
    await f.context.migrateSchema();assert.equal(vm.runInContext('SCHEMA_OK',f.context),false);
    assert.equal((await f.call('/api/mint',mint('bad-schema'),op)).code,503);assert.equal(f.state.mints.length,0);
  });
}

test('missing event amount blocks a liability read rather than treating it as zero',async t=>{
  const f=await fixture(t,{collateral:'20',circulating:'0'});
  f.db.prepare("INSERT INTO accounting_events VALUES('bad',1,NULL,1)").run();
  assert.equal((await f.call('/api/mint',mint('null-event'),op)).code,503);assert.equal(f.state.mints.length,0);
});

for(const amount of ['not-a-number','-10','1e3','1.0000000000000000001']) {
  test('malformed redemption liability cannot create headroom: '+amount,async t=>{
    const f=await fixture(t,{collateral:'10',circulating:'0'});
    f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,status) VALUES(1,'redeem',?,'base','released')").run(amount);
    assert.equal((await f.call('/api/mint',mint('bad-redemption'),op)).code,503);assert.equal(f.state.mints.length,0);
  });
}

test('unreadable asset event snapshot blocks mint before any effect',async t=>{
  let armed=false;
  const f=await fixture(t,{collateral:'20',circulating:'0',beforeQuery(sql){if(armed && assetRead(sql))throw Error('snapshot unavailable');}});
  armed=true;assert.equal((await f.call('/api/mint',mint('failed-join'),op)).code,503);assert.equal(f.state.mints.length,0);
});

test('operator cannot claim the internal deployment operation namespace',async t=>{
  const f=await fixture(t,{collateral:'10',circulating:'0'});
  assert.equal((await f.call('/api/mint',mint('representation-deploy:1:base'),op)).code,400);assert.equal(f.state.mints.length,0);
});

test('an acknowledged no-op reservation cannot reach the signer',async t=>{
  const f=await fixture(t,{collateral:'10',circulating:'0'});
  vm.runInContext("const realExec=dbExec; dbExec=(sql,params)=>sql.startsWith('INSERT INTO operations')?Promise.resolve({changes:0}):realExec(sql,params)",f.context);
  assert.equal((await f.call('/api/mint',mint('reservation-noop'),op)).code,409);assert.equal(f.state.mints.length,0);
});

test('an acknowledged no-op event write cannot report a completed mint',async t=>{
  const f=await fixture(t,{collateral:'10',circulating:'0'});
  vm.runInContext("const realExec=dbExec; dbExec=(sql,params)=>sql.startsWith('INSERT INTO accounting_events')?Promise.resolve({changes:0}):realExec(sql,params)",f.context);
  const r=await f.call('/api/mint',mint('event-noop'),op);assert.equal(r.code,500);assert.equal(r.body.reconcile,true);
  assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='event-noop'").get().state,'reconcile');
  assert.equal((await f.call('/api/mint',mint('new-after-noop'),op)).code,409);assert.equal(f.state.mints.length,1);
});

for(const mode of ['different-amount','different-representation']) {
  test('replayed accounting key cannot silently identify a '+mode,async t=>{
    const f=await fixture(t,{collateral:'10',circulating:'0'});
    const rep=mode==='different-representation'?2:1;
    f.db.prepare("INSERT INTO accounting_events VALUES('conflict',?, '1',1)").run(rep);
    await assert.rejects(f.context.recordAccountingEvent(1,'conflict',mode==='different-amount'?2n:1n),/conflicts/);
    assert.equal(f.db.prepare("SELECT delta_base FROM accounting_events WHERE event_key='conflict'").get().delta_base,'1');
  });
}

for(const protocol of ['src-20','counterparty']) {
  test('local simulated full journey: deposit, mint, owner burn proof, release, replay rejection — '+protocol,async t=>{
    const f=await fixture(t,{protocol,collateral:'0',circulating:'0'});
    f.state.sends[0].quantity='1000000000';
    const claim=f.claim({receive_address:owner.address});
    const deposited=await f.call('/api/custody/verify-deposit',claim);
    assert.equal(deposited.code,200,JSON.stringify(deposited));assert.equal(f.state.mints.length,1);
    assert.equal(await f.context.assetCirculatingBase(1),10n*10n**18n);
    assert.equal(await f.context.collateralBase(1),10n*10n**18n);
    assert.equal((await f.call('/api/custody/verify-deposit',claim)).code,409);assert.equal(f.state.mints.length,1);
    const redeem=await f.redeem();const released=await f.call('/api/custody/redeem',redeem);
    assert.equal(released.code,200,JSON.stringify(released));assert.equal(f.state.releases.length,1);
    assert.equal(await f.context.assetCirculatingBase(1),0n);
    assert.equal(await f.context.collateralBase(1)-await f.context.redeemedBase(1),0n);
    assert.equal((await f.call('/api/custody/redeem',redeem)).code,409);assert.equal(f.state.releases.length,1);
  });
}
