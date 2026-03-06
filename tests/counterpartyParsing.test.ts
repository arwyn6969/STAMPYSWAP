import assert from 'node:assert/strict';
import test from 'node:test';
import { getBalances, getOrders } from '../src/lib/counterparty.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

test('getOrders parses integer-string quantities as bigint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    jsonResponse({
      result: [
        {
          tx_hash: 'abc',
          source: '1source',
          give_asset: 'xcp',
          give_quantity: '123456789012345678901234567890',
          give_remaining: '100',
          get_asset: 'rarepepe',
          get_quantity: '200',
          get_remaining: '200',
          expiration: 100,
          expire_index: 1,
          status: 'open',
          give_price: 0,
          get_price: 0,
          block_time: 0,
        },
      ],
    })) as typeof fetch;

  const orders = await getOrders('XCP', 'RAREPEPE', 'open', { force: true });
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.give_asset, 'XCP');
  assert.equal(order.get_asset, 'RAREPEPE');
  assert.equal(order.give_quantity, 123456789012345678901234567890n);
  assert.equal(order.get_quantity, 200n);
});

test('getOrders drops malformed rows that use unsafe numeric quantities', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    jsonResponse({
      result: [
        {
          tx_hash: 'bad',
          source: '1source',
          give_asset: 'XCP',
          give_quantity: Number.MAX_SAFE_INTEGER + 1,
          give_remaining: 1,
          get_asset: 'RAREPEPE',
          get_quantity: 1,
          get_remaining: 1,
          expiration: 100,
          expire_index: 1,
          status: 'open',
          give_price: 0,
          get_price: 0,
          block_time: 0,
        },
      ],
    })) as typeof fetch;

  const orders = await getOrders('XCP', 'RAREPEPE', 'open', { force: true });
  assert.equal(orders.length, 0);
});

test('getBalances parses integer-string quantities as bigint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    jsonResponse({
      result: [
        {
          address: 'bc1qtestaddress0000000000000000000000000000',
          asset: 'xcp',
          quantity: '999999999999999999999999',
          quantity_normalized: '9999999.99999999',
        },
      ],
    })) as typeof fetch;

  const balances = await getBalances('bc1qtestaddress0000000000000000000000000000', { force: true });
  assert.equal(balances.length, 1);
  const [balance] = balances;
  assert.equal(balance.asset, 'XCP');
  assert.equal(balance.quantity, 999999999999999999999999n);
});
