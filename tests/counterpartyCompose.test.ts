import assert from 'node:assert/strict';
import test from 'node:test';
import { composeOrder } from '../src/lib/counterparty.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

test('composeOrder serializes bigint quantities without precision loss', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calledUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return jsonResponse({
      result: {
        rawtransaction: '00',
        params: {},
        name: 'order',
      },
    });
  }) as typeof fetch;

  await composeOrder({
    address: 'bc1qexampleaddress0000000000000000000000000000',
    give_asset: 'XCP',
    give_quantity: 123456789012345678901234567890n,
    get_asset: 'RAREPEPE',
    get_quantity: '42',
    expiration: 100,
  });

  assert.ok(calledUrl.includes('/compose/order?'));
  const url = new URL(calledUrl);
  assert.equal(url.searchParams.get('give_quantity'), '123456789012345678901234567890');
  assert.equal(url.searchParams.get('get_quantity'), '42');
  assert.equal(url.searchParams.get('fee_required'), '0');
});

test('composeOrder rejects unsafe JS number quantities', async () => {
  await assert.rejects(
    () =>
      composeOrder({
        address: 'bc1qexampleaddress0000000000000000000000000000',
        give_asset: 'XCP',
        give_quantity: Number.MAX_SAFE_INTEGER + 1,
        get_asset: 'RAREPEPE',
        get_quantity: 1,
        expiration: 100,
      }),
    /safe integer/i,
  );
});
