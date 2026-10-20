'use strict'
// Real handler routing and real BIP-322/EIP-191 signatures; external effects are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { fixture, owner, attacker, token, btcSource, dep, op } = require('./audit-e.fixture.cjs')
const bip = dep('bip322-js')
const btcKey = dep('ecpair').ECPairFactory(dep('@bitcoinerlab/secp256k1')).fromPrivateKey(Buffer.alloc(32, 7))
const state = f => Object.fromEntries(['collateral_ledger', 'accounting_events', 'operations', 'consumed_burns'].map(table => [table, f.db.prepare('SELECT * FROM ' + table).all()]))
async function refused(f, route, body) {
  const before = state(f)
  const result = await f.call(route, body, op)
  assert.equal(result.code, 401, JSON.stringify(result.body))
  assert.match(result.body.binding_message, /^StampySwap authorization v1\n/)
  assert.deepEqual(state(f), before)
  assert.equal(f.state.mints.length + f.state.releases.length, 0)
  return result
}
function ethereumRepresentation(f) {
  f.db.prepare("INSERT INTO representations(id,canonical_id,dest_chain,dest_address,circulating_supply,status) VALUES(2,1,'ethereum',?,'100','CANONICAL')").run(token)
  f.db.prepare("INSERT INTO accounting_events VALUES('ethereum-baseline',2,'100000000000000000000',1)").run()
}

for (const [field, change] of [['destination chain', { chain: 'ethereum' }], ['deposit transaction', { txid: 'another-deposit' }]]) {
  test('deposit handler refuses substitution of ' + field + ' before consumption/mint', async t => {
    const f = await fixture(t)
    await refused(f, '/api/custody/verify-deposit', { ...f.claim(), ...change })
  })
}
for (const [field, sql] of [['source protocol', "UPDATE canonical_assets SET source_protocol='counterparty' WHERE id=1"], ['deploy identity', "UPDATE canonical_assets SET deploy_tx='other-deploy' WHERE id=1"]]) {
  test('deposit handler binds resolved ' + field + ', beyond the display ticker', async t => {
    const f = await fixture(t)
    const claim = f.claim()
    f.db.exec(sql)
    await refused(f, '/api/custody/verify-deposit', claim)
  })
}
test('deposit handler cannot replay an authorization across app groups or custody vaults', async t => {
  const a = await fixture(t)
  const original = a.claim()
  const b = await fixture(t, { env: { ARTIFACT_GROUP: 'isolated-staging' } })
  await refused(b, '/api/custody/verify-deposit', original)
  vm.runInContext("VAULT_ADDR='other-vault'", a.context)
  await refused(a, '/api/custody/verify-deposit', original)
})

test('redeem handler cannot reinterpret a signature for another source chain', async t => {
  const f = await fixture(t)
  const original = await f.redeem()
  ethereumRepresentation(f)
  await refused(f, '/api/custody/redeem', { ...original, chain: 'ethereum' })
})
test('redeem handler binds the registered representation address', async t => {
  const f = await fixture(t)
  const original = await f.redeem()
  f.db.prepare('UPDATE representations SET dest_address=? WHERE id=1').run(attacker.address)
  f.state.receipt.logs[0].address = attacker.address
  await refused(f, '/api/custody/redeem', original)
})
test('move handler binds the source chain before consuming or debiting a burn', async t => {
  const f = await fixture(t)
  const original = f.move({ to_chain: 'solana' })
  ethereumRepresentation(f)
  await refused(f, '/api/move', { ...original, from_chain: 'ethereum' })
})
test('move handler binds its registered source representation', async t => {
  const f = await fixture(t)
  const original = f.move()
  f.db.prepare('UPDATE representations SET dest_address=? WHERE id=1').run(attacker.address)
  f.state.receipt.logs[0].address = attacker.address
  await refused(f, '/api/move', original)
})

test('legacy deposit signatures have no handler acceptance fallback', async t => {
  const f = await fixture(t)
  const body = f.claim()
  const oldMessage = `StampySwap deposit authorization\nSource: ${btcSource}\nReceive: ${body.receive_address}\nAsset: COIN\nAmount: ${body.amount}\nI control the source Bitcoin address and authorize minting this deposit to the receive address above.`
  body.binding_sig = bip.Signer.sign(btcKey.toWIF(), btcSource, oldMessage)
  await refused(f, '/api/custody/verify-deposit', body)
})
test('legacy redeem signatures have no handler acceptance fallback', async t => {
  const f = await fixture(t)
  const body = await f.redeem()
  body.auth_sig = await owner.signMessage(`StampySwap redeem: burn ${body.burn_txid} → release ${body.amount} to ${body.to}`)
  await refused(f, '/api/custody/redeem', body)
})
test('legacy move signatures have no handler acceptance fallback', async t => {
  const f = await fixture(t)
  const body = f.move()
  body.auth_sig = await owner.signMessage(`StampySwap move: burn ${body.burn_txid} → mint ${body.amount} on ${body.to_chain} to ${body.to_address}`)
  await refused(f, '/api/move', body)
})
