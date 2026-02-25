import assert from 'node:assert/strict';
import test from 'node:test';
import { getTransactionStatus } from '../src/lib/counterparty.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
  });
}

test('getTransactionStatus prefers counterparty when available', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/bitcoin/transactions/')) {
      return jsonResponse({
        result: {
          status: 'confirmed',
          confirmations: 3,
          block_height: 840000,
          block_time: 1700000000,
        },
      });
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  }) as typeof fetch;

  const status = await getTransactionStatus('txid-counterparty');
  assert.equal(status.status, 'confirmed');
  assert.equal(status.confirmations, 3);
  assert.equal(status.blockHeight, 840000);
  assert.equal(status.source, 'counterparty');
});

test('getTransactionStatus falls back to mempool.space when counterparty misses', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.counterparty.io')) {
      return jsonResponse({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    }
    if (url.includes('mempool.space/api/tx/') && url.endsWith('/status')) {
      return jsonResponse({ confirmed: false });
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  }) as typeof fetch;

  const status = await getTransactionStatus('txid-mempool');
  assert.equal(status.status, 'mempool');
  assert.equal(status.confirmations, 0);
  assert.equal(status.source, 'mempool.space');
});

test('getTransactionStatus calculates confirmations from tip height', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.counterparty.io')) {
      return jsonResponse({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    }
    if (url.includes('mempool.space/api/tx/') && url.endsWith('/status')) {
      return jsonResponse({ confirmed: true, block_height: 100, block_time: 1700000100 });
    }
    if (url.includes('mempool.space/api/blocks/tip/height')) {
      return textResponse('105');
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  }) as typeof fetch;

  const status = await getTransactionStatus('txid-confirmed');
  assert.equal(status.status, 'confirmed');
  assert.equal(status.confirmations, 6);
  assert.equal(status.blockHeight, 100);
  assert.equal(status.source, 'mempool.space');
});

test('getTransactionStatus falls back to blockstream if mempool.space fails', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.counterparty.io')) {
      return jsonResponse({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    }
    if (url.includes('mempool.space/api/tx/') && url.endsWith('/status')) {
      return jsonResponse({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    }
    if (url.includes('blockstream.info/api/tx/') && url.endsWith('/status')) {
      return jsonResponse({ confirmed: false });
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  }) as typeof fetch;

  const status = await getTransactionStatus('txid-blockstream');
  assert.equal(status.status, 'mempool');
  assert.equal(status.source, 'blockstream');
});
