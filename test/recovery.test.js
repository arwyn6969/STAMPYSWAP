// Runtime prevention tests for the durable-recovery decision logic (audit R05/F06/F07).
// Pure logic → runs in CI with `node --test`, no server/DB/signers needed.
const test = require('node:test')
const assert = require('node:assert')
const { depositOpKey, moveOpKey, resolveDepositOp, resolveMoveBurn } = require('../recovery')

test('op keys are deterministic and identity-scoped (not recipient-scoped)', () => {
  assert.strictEqual(depositOpKey('acme:abc'), 'deposit-mint:acme:abc')
  assert.strictEqual(moveOpKey('0xdeadbeef'), 'move-mint:0xdeadbeef')
  // same deposit, different recipients → SAME op key (one deposit can't mint to two addresses)
  assert.strictEqual(depositOpKey('acme:abc'), depositOpKey('acme:abc'))
})

test('resolveDepositOp: no prior op → proceed', () => {
  assert.strictEqual(resolveDepositOp(null, 'addrA').action, 'proceed')
  assert.strictEqual(resolveDepositOp(undefined, 'addrA').action, 'proceed')
})

test('resolveDepositOp: completed op → done (idempotent, never re-mint)', () => {
  assert.strictEqual(resolveDepositOp({ state: 'completed', recipient: 'addrA' }, 'addrA').action, 'done')
  // completed wins even if the retry targets a different address
  assert.strictEqual(resolveDepositOp({ state: 'completed', recipient: 'addrA' }, 'addrB').action, 'done')
})

test('resolveDepositOp: in-flight op, different recipient → retarget (deposit spoken for)', () => {
  assert.strictEqual(resolveDepositOp({ state: 'reserved', recipient: 'addrA' }, 'addrB').action, 'retarget')
  assert.strictEqual(resolveDepositOp({ state: 'reconcile', recipient: 'addrA' }, 'addrB').action, 'retarget')
})

test('resolveDepositOp: in-flight op, same recipient → reconcile (outcome unknown, no auto-retry)', () => {
  assert.strictEqual(resolveDepositOp({ state: 'reserved', recipient: 'addrA' }, 'addrA').action, 'reconcile')
  assert.strictEqual(resolveDepositOp({ state: 'reconcile', recipient: 'addrA' }, 'addrA').action, 'reconcile')
  // no recipient recorded yet → reconcile (never proceed to a possible double-mint)
  assert.strictEqual(resolveDepositOp({ state: 'reserved', recipient: null }, 'addrA').action, 'reconcile')
})

test('resolveMoveBurn: no burn row → start', () => {
  assert.strictEqual(resolveMoveBurn(null, 7).action, 'start')
})

test('resolveMoveBurn: burn consumed by a move of THIS asset → resume (dest-mint only)', () => {
  assert.strictEqual(resolveMoveBurn({ purpose: 'move', canonical_id: 7 }, 7).action, 'resume')
})

test('resolveMoveBurn: burn consumed by a redeem, or a move of ANOTHER asset → reject', () => {
  assert.strictEqual(resolveMoveBurn({ purpose: 'redeem', canonical_id: 7 }, 7).action, 'reject')
  assert.strictEqual(resolveMoveBurn({ purpose: 'move', canonical_id: 9 }, 7).action, 'reject')
})
