// Independent 1 October 2026 whole-server repair audit.
// OPEN cases pass by reproducing a defect. VERIFIED cases assert the protective behavior.
// Uses hash-pinned source; real SQLite, routing and signatures; no live signing or broadcasts.
const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm');
const {fixture,owner,attacker,token,burnId,btcSource,op,read,dep,load}=require('./independent-fixture.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const mint=(key,chain='base')=>({tick:'COIN',amount:'10',chain,receive_address:owner.address,op_key:key});
function pending(f,id=50,burn=burnId){
 f.db.prepare("INSERT INTO collateral_ledger(id,canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(?,1,'redeem','10','base',?,'reconcile')").run(id,burn);
 f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'redeem','10')").run(burn);
}
const recon=(f,id=50)=>f.call('/api/reconcile',{kind:'redeem',id,resolution:'released',release_txid:'release-'+id},op);
const supply=(f,chain='base')=>f.db.prepare("SELECT circulating_supply c FROM representations WHERE dest_chain=?").get(chain)?.c;

test('OPEN C01/B01: stale supply snapshot before reservation survives an expired lease and overissues',async t=>{
 const clock={now:1000000},entered=deferred(),resume=deferred();let pause=true;
 const a=await fixture(t,{collateral:'10',circulating:'0',clock,async beforeExec(sql,params){
  if(pause && sql.startsWith('INSERT INTO operations') && params[0]==='stale-A'){pause=false;entered.resolve();await resume.promise;}
 }});
 const b=await fixture(t,{db:a.db,clock});t.after(()=>resume.resolve());
 const first=a.call('/api/mint',mint('stale-A'),op);await entered.promise;
 clock.now+=31000;
 assert.equal((await b.call('/api/mint',mint('fresh-B'),op)).code,200);
 resume.resolve();assert.equal((await first).code,200);
 assert.equal(a.state.mints.length+b.state.mints.length,2);
 assert.equal(a.circ(),'20');assert.equal(await a.context.collateralBase(1),10n*10n**18n);
});

test('OPEN C02/B04: reservation-read error is converted to zero and reuses uncertain backing',async t=>{
 let loseMint=true,failRead=false;
 const f=await fixture(t,{collateral:'10',circulating:'0',
  afterMint(){if(loseMint){loseMint=false;throw Error('accepted mint, response lost');}},
  beforeQuery(sql){if(failRead && sql.startsWith('SELECT op_key, amount FROM operations'))throw Error('reservation read unavailable');}
 });
 assert.equal((await f.call('/api/mint',mint('uncertain'),op)).code,502);
 failRead=true;
 assert.equal((await f.call('/api/mint',mint('new-key'),op)).code,200);
 assert.equal(f.state.mints.length,2);assert.equal(f.circ(),'10');
 assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='uncertain'").get().state,'reconcile');
});

test('OPEN C03/B02: an older absolute supply write overwrites a newer sum and permits extra mint',async t=>{
 const clock={now:1000000},entered=deferred(),resume=deferred();let pause=true;
 const a=await fixture(t,{collateral:'120',circulating:'100',clock,async beforeExec(sql,params){
  if(pause && sql.startsWith('UPDATE representations SET circulating_supply=') && params[0]==='110'){pause=false;entered.resolve();await resume.promise;}
 }});
 const b=await fixture(t,{db:a.db,clock});t.after(()=>resume.resolve());
 const first=a.call('/api/mint',mint('sum-A'),op);await entered.promise;clock.now+=31000;
 assert.equal((await b.call('/api/mint',mint('sum-B'),op)).code,200);assert.equal(a.circ(),'120');
 resume.resolve();assert.equal((await first).code,200);assert.equal(a.circ(),'110');
 assert.equal((await a.call('/api/mint',mint('extra-C'),op)).code,200);
 assert.equal(a.state.mints.length+b.state.mints.length,3);assert.equal(a.circ(),'130');
 assert.equal(await a.context.collateralBase(1),120n*10n**18n);
});

test('OPEN C04/B03/B05: restart baseline cancels an unmaterialized mint event on a new representation',async t=>{
 let fail=true;
 const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){
  if(fail && sql.startsWith('UPDATE representations SET circulating_supply='))throw Error('cache write failed persistently');
 }});
 const first=await f.call('/api/mint',mint('new-rep-crash','ethereum'),op);
 assert.equal(first.code,500);assert.equal(supply(f,'ethereum'),'0');assert.equal(f.state.mints.length,1);
 fail=false;
 const reboot=await fixture(t,{db:f.db});
 const rep=f.db.prepare("SELECT id FROM representations WHERE dest_chain='ethereum'").get();
 assert.equal(f.db.prepare("SELECT delta_base FROM accounting_events WHERE event_key=?").get('baseline:'+rep.id).delta_base,(-10n*10n**18n).toString());
 assert.equal((await reboot.call('/api/reconcile',{kind:'mint',op_key:'new-rep-crash',resolution:'completed',release_txid:'known-onchain-mint'},op)).code,200);
 assert.equal(supply(f,'ethereum'),'0');
 assert.equal((await reboot.call('/api/mint',mint('extra-after-restart','ethereum'),op)).code,200);
 assert.equal(f.state.mints.length+reboot.state.mints.length,2);assert.equal(supply(f,'ethereum'),'10');
});

function custodyFixture(psbt,env={}){
 const bitcoin=dep('bitcoinjs-lib');let signed=0;
 const c=load('custody.js',n=>{
  if(n==='@emblemvault/auth-sdk/signers/bitcoin')return {fetchBitcoinVaultInfo:async()=>({btcAddresses:{p2wpkh:btcSource}}),toBitcoinSigner:async()=>({signPsbt:async()=>{signed++;return {signedTxHex:'00'}}})};
  if(n==='bitcoinjs-lib')return bitcoin;if(n==='fs')return {existsSync:()=>false};if(n==='path')return require('node:path');if(n==='./acme')return null;
  throw Error('Unexpected dependency '+n);
 },{process:{env:{STAMPY_CUSTODY_LIVE:'1',...env}},fetch:async url=>url.includes('/src20/create')
 ?{ok:true,json:async()=>({hex:psbt.toHex(),inputsToSign:[{index:0,sighashType:1}]})}
 :{ok:true,text:async()=>'aa'.repeat(32)}}).exports;
 return {c,signed:()=>signed};
}
function psbt(input=1000000){
 const bitcoin=dep('bitcoinjs-lib'),p=new bitcoin.Psbt({network:bitcoin.networks.bitcoin});
 p.addInput({hash:'11'.repeat(32),index:0,witnessUtxo:{script:bitcoin.address.toOutputScript(btcSource),value:input}});return p;
}
const recipient=()=>dep('bitcoinjs-lib').payments.p2wpkh({hash:Buffer.alloc(20,9)}).address;

test('OPEN C05/B09: a spendable bare public-key output bypasses the non-vault value caps',async()=>{
 const bitcoin=dep('bitcoinjs-lib');
 const key=dep('ecpair').ECPairFactory(dep('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32,9));
 const script=bitcoin.payments.p2pk({pubkey:Buffer.from(key.publicKey)}).output;
 assert.throws(()=>bitcoin.address.fromOutputScript(script)); // classified as "data" by guard
 const p=psbt();p.addOutput({script,value:999000});p.addOutput({address:btcSource,value:500}); // fee only 500
 const f=custodyFixture(p),r=await f.c.redeem({tick:'COIN',amount:'10',toAddress:recipient()});
 assert.equal(r.released,true);assert.equal(f.signed(),1);
});

test('OPEN B09 residual: an unrelated dust recipient with no data payload still reaches signer',async()=>{
 const p=psbt(10000);p.addOutput({address:recipient(),value:330});p.addOutput({address:btcSource,value:9000});
 const requested=dep('bitcoinjs-lib').payments.p2wpkh({hash:Buffer.alloc(20,8)}).address;
 const f=custodyFixture(p);assert.equal((await f.c.redeem({tick:'COIN',amount:'10',toAddress:requested})).released,true);
 assert.equal(f.signed(),1); // requires neither data nor the requested recipient
});

test('VERIFIED B01 narrow: lease expiry during an already-reserved mint blocks a competitor',async t=>{
 const clock={now:1000000},entered=deferred(),resume=deferred();
 const a=await fixture(t,{collateral:'10',circulating:'0',clock,async beforeMint(){entered.resolve();await resume.promise;}});
 const b=await fixture(t,{db:a.db,clock});t.after(()=>resume.resolve());
 const first=a.call('/api/mint',mint('reserved-A'),op);await entered.promise;clock.now+=31000;
 assert.equal((await b.call('/api/mint',mint('competitor-B'),op)).code,409);
 resume.resolve();assert.equal((await first).code,200);assert.equal(a.state.mints.length+b.state.mints.length,1);
});

for(const boundary of ['before-event','after-event','before-cache','after-cache','before-terminal','after-terminal']){
 test('VERIFIED B02/B05 release retry and restart at '+boundary,async t=>{
  let armed=true;
  const hit=(sql)=>boundary.includes('event')?sql.startsWith('INSERT INTO accounting_events'):
   boundary.includes('cache')?sql.startsWith('UPDATE representations SET circulating_supply='):
   sql.startsWith("UPDATE collateral_ledger SET status='released'");
  const f=await fixture(t,{beforeExec(sql,params){
   if(armed && boundary.startsWith('before') && hit(sql) && !String(params[0]).startsWith('baseline:'))throw Error('stop before '+boundary);
  },afterExec(sql,params){
   if(armed && boundary.startsWith('after') && hit(sql) && !String(params[0]).startsWith('baseline:')){armed=false;throw Error('committed then lost '+boundary);}
  }});
  pending(f);const first=await recon(f);armed=false;
  if(boundary.startsWith('before'))assert.equal(first.code,500);else assert.ok([200,500].includes(first.code));
  const reboot=await fixture(t,{db:f.db});
  const second=await recon(reboot);assert.ok([200,409].includes(second.code));
  assert.equal(f.circ(),'90');
  assert.equal(f.db.prepare("SELECT count(*) n FROM accounting_events WHERE event_key='release:50'").get().n,1);
  assert.equal((await reboot.call('/api/mint',mint('no-unbacked-mint'),op)).code,409);
 });
}

test('VERIFIED B03 narrow: insert failure retains reservation and does not return completed success',async t=>{
 let fail=true;const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){if(fail && sql.startsWith('INSERT INTO representations'))throw Error('insert unavailable');}});
 assert.equal((await f.call('/api/mint',mint('rep-failure','ethereum'),op)).code,500);fail=false;
 assert.equal((await f.call('/api/mint',mint('other','ethereum'),op)).code,409);
 const repair=await f.call('/api/reconcile',{kind:'mint',op_key:'rep-failure',resolution:'completed',release_txid:'known-mint'},op);
 assert.equal(repair.code,409);assert.match(repair.body.error,/no representation row/); // residual: operator must repair row outside this action
 assert.equal(f.state.mints.length,1);
});

test('VERIFIED B04 narrow: an uncertain external mint blocks a different key across restart',async t=>{
 const f=await fixture(t,{collateral:'10',circulating:'0',afterMint(){throw Error('accepted then lost');}});
 assert.equal((await f.call('/api/mint',mint('uncertain'),op)).code,502);
 const reboot=await fixture(t,{db:f.db});assert.equal((await reboot.call('/api/mint',mint('other'),op)).code,409);
 assert.equal(f.state.mints.length+reboot.state.mints.length,1);
});

test('OPEN C06/B05: a failed move cache write has no complete repair through the phase-only action',async t=>{
 let fail=true;const f=await fixture(t,{beforeExec(sql){if(fail && sql.startsWith('UPDATE representations SET circulating_supply='))throw Error('persistent cache failure');}});
 assert.equal((await f.call('/api/move',f.move(),op)).code,500);fail=false;
 const inventory=await f.call('/api/reconcile',undefined,op);assert.equal(inventory.body.stuck_moves.length,1);
 const repaired=await f.call('/api/reconcile',{kind:'move',burn_txid:burnId,resolution:'decremented'},op);
 assert.equal(repaired.code,200);assert.equal(f.circ(),'100'); // event sum is 90, materialization still 100
 assert.equal((await f.call('/api/move',f.move(),op)).code,409);
 assert.equal((await f.call('/api/reconcile',undefined,op)).body.stuck_moves.length,0);
 assert.equal(f.state.mints.length,0);
});

test('VERIFIED B06: aborted move survives reboot and can actually finish its retry',async t=>{
 const f=await fixture(t);
 f.db.prepare("INSERT INTO consumed_burns(burn_txid,chain,canonical_id,purpose,amount) VALUES(?,'base',1,'move','10')").run(burnId);
 f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,btc_txid,status) VALUES(1,'move-out','10','base',?,'pending')").run(burnId);
 assert.equal((await f.call('/api/reconcile',{kind:'move',burn_txid:burnId,resolution:'aborted'},op)).code,200);
 const reboot=await fixture(t,{db:f.db});
 assert.equal(f.db.prepare('SELECT count(*) n FROM consumed_burns').get().n,0);
 assert.equal((await reboot.call('/api/move',reboot.move(),op)).code,200);
 assert.equal(f.circ(),'90');assert.equal(reboot.state.mints.length,1);
});

test('VERIFIED B06: NULL historical redeemed burn stays consumed after two migrations',async t=>{
 const f=await fixture(t);
 f.db.prepare("INSERT INTO collateral_ledger(canonical_id,direction,amount,dest_chain,burn_txid,status) VALUES(1,'redeem','10','base',?,NULL)").run(burnId);
 await f.context.migrateSchema();await f.context.migrateSchema();
 assert.equal((await f.call('/api/custody/redeem',await f.redeem())).code,409);assert.equal(f.state.releases.length,0);
});

for(const mode of ['no-lock-key','partial-op','composite-op','no-event-key','valid-not-null-index']){
 test('VERIFIED B07 schema gate: '+mode,async t=>{
  const f=await fixture(t);
  if(mode==='no-lock-key')f.db.exec('DROP TABLE asset_locks; CREATE TABLE asset_locks(asset_id INTEGER,holder TEXT,acquired_at INTEGER,expires_at INTEGER)');
  if(mode==='partial-op'||mode==='composite-op'||mode==='valid-not-null-index'){
   f.db.exec("DROP TABLE operations; CREATE TABLE operations(op_key TEXT,action TEXT,canonical_id INTEGER,amount TEXT,chain TEXT,recipient TEXT,state TEXT,created_at INTEGER,updated_at INTEGER,tx_id TEXT,result_json TEXT)");
   f.db.exec(mode==='partial-op'?"CREATE UNIQUE INDEX gate ON operations(op_key) WHERE state='completed'":
    mode==='composite-op'?"CREATE UNIQUE INDEX gate ON operations(op_key,state)":"CREATE UNIQUE INDEX gate ON operations(op_key) WHERE op_key IS NOT NULL");
  }
  if(mode==='no-event-key')f.db.exec('DROP TABLE accounting_events; CREATE TABLE accounting_events(event_key TEXT,rep_id INTEGER,delta_base TEXT,created_at INTEGER)');
  vm.runInContext('SCHEMA_OK=false',f.context);await f.context.migrateSchema();
  assert.equal(vm.runInContext('SCHEMA_OK',f.context),mode==='valid-not-null-index');
  if(mode!=='valid-not-null-index')assert.equal((await f.call('/api/mint',mint('schema-fail'),op)).code,503);
 });
}

for(const action of ['redeem','move']){
 test('VERIFIED B08: actual EVM wallet helper and '+action+' form complete owner authorization',async t=>{
  const f=await fixture(t);
  const fields={'#rr-tick':{value:'COIN'},'#rr-amount':{value:'10'},'#rr-chain':{value:'base'},'#rr-txid':{value:burnId},'#rr-to':{value:btcSource},'#rr-out':{innerHTML:''},
   '#mv-asset':{value:'COIN'},'#mv-amount':{value:'10'},'#mv-from':{value:'base'},'#mv-to':{value:'ethereum'},'#mv-txid':{value:burnId},'#mv-toaddr':{value:owner.address},'#mv-out':{innerHTML:''}};
  const requests=[];let signCalls=0;
  const ui=vm.createContext({window:{},state:{evmWallet:{address:owner.address,provider:{request:async({method,params})=>{
   assert.equal(method,'personal_sign');assert.equal(params[1],owner.address);signCalls++;return owner.signMessage(params[0]);}}}},
   $:s=>fields[s],esc:String,disp:String,loadReserves2(){},TextEncoder,
   fetch:async(url,args)=>{const body=JSON.parse(args.body),r=await f.call('/'+url,body);requests.push({request:body,...r});return {json:async()=>r.body};}
  });
  const wallet=read('public/wallet.js');vm.runInContext(wallet.slice(wallet.indexOf('  async function signSolanaMessage('),wallet.indexOf('  async function connectDeposit(')),ui);
  const html=read('public/index.html'),start=html.indexOf(action==='redeem'?'async function doRealRedeem(){':'async function doMove(){');
  vm.runInContext(html.slice(start,html.indexOf('\n}',start)+2),ui);
  await vm.runInContext(action==='redeem'?'doRealRedeem()':'doMove()',ui);
  assert.equal(requests.length,2);assert.equal(requests[0].code,401);assert.equal(requests[1].code,200);
  assert.equal(signCalls,1);assert.ok(requests[1].request.auth_sig);assert.equal(requests[1].request.burn_txid,burnId);
 });
}

test('VERIFIED B09 narrow: excessive declared miner fee is refused before signer access',async()=>{
 const p=psbt();p.addOutput({address:btcSource,value:546});const f=custodyFixture(p);
 await assert.rejects(f.c.redeem({tick:'COIN',amount:'10',toAddress:recipient()}),/miner fee/);assert.equal(f.signed(),0);
});

test('VERIFIED containment: default maintenance, path variants, retired routes and custody gate',async t=>{
 const f=await fixture(t,{env:{STAMPY_MAINTENANCE:undefined,STAMPY_PREVIEW:'1'}});
 const status=await f.call('/api/status');assert.equal(status.body.maintenance,true);
 for(const route of ['/api/mint','/API/MINT/','/api//mint','/api/custody/redeem','/api/move']){
  assert.equal((await f.call(route,mint('not-sent'))).code,503);
 }
 assert.equal((await f.call('/api/redeem',{},op)).code,410);
 const p=psbt();p.addOutput({address:btcSource,value:999000});const c=custodyFixture(p,{STAMPY_CUSTODY_LIVE:'0'});
 await assert.rejects(c.c.redeem({tick:'COIN',amount:'10',toAddress:recipient()}),e=>e.code==='GATED');assert.equal(c.signed(),0);
 assert.equal(f.state.mints.length+f.state.releases.length,0);
});

for(const boundary of ['before-event','after-event','before-cache','after-cache','before-ledger','after-ledger','after-complete']){
 test('VERIFIED mint recovery on an existing representation at '+boundary,async t=>{
  let armed=false;
  const hit=(sql)=>boundary.includes('event')?sql.startsWith('INSERT INTO accounting_events'):
   boundary.includes('cache')?sql.startsWith('UPDATE representations SET circulating_supply='):
   boundary.includes('ledger')?sql.startsWith('INSERT INTO collateral_ledger'):
   sql.startsWith("UPDATE operations SET state='completed'");
  const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){
   if(armed && boundary.startsWith('before') && hit(sql))throw Error('stop before '+boundary);
  },afterExec(sql){
   if(armed && boundary.startsWith('after') && hit(sql)){armed=false;throw Error('lost response after '+boundary);}
  }});
  armed=true;const first=await f.call('/api/mint',mint('recover-existing'),op);armed=false;
  assert.ok([200,500].includes(first.code));assert.equal(f.state.mints.length,1);
  const reboot=await fixture(t,{db:f.db});
  const r=await reboot.call('/api/reconcile',{kind:'mint',op_key:'recover-existing',resolution:'completed',release_txid:'confirmed-mint'},op);
  assert.ok([200,409].includes(r.code));assert.equal(f.circ(),'10');
  assert.equal(f.db.prepare("SELECT count(*) n FROM accounting_events WHERE event_key='mint:recover-existing'").get().n,1);
  assert.equal((await reboot.call('/api/mint',mint('recover-existing'),op)).code,200);
  assert.equal(reboot.state.mints.length,0);assert.equal((await reboot.call('/api/mint',mint('cannot-reuse'),op)).code,409);
 });
}

test('OPEN retained limitation: opComplete persistence failure still returns mint success',async t=>{
 const f=await fixture(t,{collateral:'10',circulating:'0',beforeExec(sql){
  if(sql.startsWith("UPDATE operations SET state='completed'"))throw Error('completion write unavailable');
 }});
 assert.equal((await f.call('/api/mint',mint('completion-failed'),op)).code,200);
 assert.equal(f.db.prepare("SELECT state FROM operations WHERE op_key='completion-failed'").get().state,'reserved');
 assert.equal((await f.call('/api/mint',mint('completion-failed'),op)).code,409);
 assert.equal(f.circ(),'10');assert.equal(f.state.mints.length,1);
});

for(const errorType of ['transient','not-found']){
 test('VERIFIED additional Solana repair: '+errorType+' lookup cannot create a replacement mint',async()=>{
  const web3=dep('@solana/web3.js'),key=web3.Keypair.fromSeed(Buffer.alloc(32,4));let creates=0,lookups=0;
  const adapter=load('sol-mint.js',n=>{
   if(n==='@solana/web3.js')return {...web3,Connection:class{async getBalance(){return web3.LAMPORTS_PER_SOL;}}};
   if(n==='@solana/spl-token')return {getMint:async()=>{lookups++;throw Error(errorType==='transient'?'temporary RPC timeout':'could not find mint');},createMint:async()=>{creates++;throw Error('must not create replacement');}};
   if(n==='@emblemvault/auth-sdk/signers/solana')return {toSolanaWeb3Signer:async()=>({publicKey:key.publicKey.toBase58()})};
   if(n==='fs')return {existsSync:()=>true,readFileSync:()=>JSON.stringify(Array.from(key.secretKey))};
   if(n==='path')return require('node:path');throw Error('unexpected dependency '+n);
  },{setTimeout:fn=>{fn();return 0;}}).exports;
  await assert.rejects(adapter.mintTokens({existingMint:key.publicKey.toBase58(),recipient:key.publicKey.toBase58(),amountBase:10n}),e=>e.code===(errorType==='transient'?'RPC_UNCERTAIN':'MINT_MISSING'));
  assert.equal(creates,0);assert.equal(lookups,errorType==='transient'?4:1);
 });
}

for(const kind of ['standard','injected']){
 test('VERIFIED B08: Solana '+kind+' signing helper returns a verifiable owner signature',async()=>{
  const nacl=dep('tweetnacl'),bs58=dep('bs58').default,key=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
  const account={address:bs58.encode(key.publicKey)},message='StampySwap test authorization';
  const wallet=kind==='standard'?{features:{'solana:signMessage':{signMessage:async({account:a,message:m})=>{assert.equal(a,account);return [{signature:nacl.sign.detached(m,key.secretKey)}];}}}}:
   {signMessage:async m=>({signature:nacl.sign.detached(m,key.secretKey)})};
  const ui=vm.createContext({window:{},state:{receiveWallet:{kind,wallet,account}},TextEncoder,bs58encode:bs58.encode});
  const src=read('public/wallet.js');vm.runInContext(src.slice(src.indexOf('  async function signSolanaMessage('),src.indexOf('  async function connectDeposit(')),ui);
  const sig=await ui.window.stampySignForChain('solana',message);
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode(message),bs58.decode(sig),key.publicKey),true);
 });
}
