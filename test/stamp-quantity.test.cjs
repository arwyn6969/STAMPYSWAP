'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, btcSource, op } = require('./audit-e.fixture.cjs')

test('indivisible stamp bridge passes exact zero-decimal source quantity to custody', async t => {
  const f = await fixture(t)
  f.db.prepare("INSERT INTO stamp_bridges VALUES(1,'COIN','STAMP','counterparty',2,'fixture-burn',1)").run()
  f.state.src.destination = 'fixture-burn'
  f.custody.redeem = async args => {
    assert.equal(args.dec, 0, 'an indivisible stamp cannot use the divisible-asset default')
    assert.equal(args.amount, '20')
    assert.equal(args.qtyBase, '20')
    assert.equal(args.toAddress, btcSource)
    f.state.releases.push(args)
    return { released: true, txid: 'fixture-stamp-release' }
  }
  const response = await f.call('/api/stampbridge/execute', { src20_tick: 'COIN', amount: '10', burn_txid: 'fixture-stamp-burn', user_address: btcSource }, op)
  assert.equal(response.code, 200)
  assert.equal(f.state.releases.length, 1)
})
