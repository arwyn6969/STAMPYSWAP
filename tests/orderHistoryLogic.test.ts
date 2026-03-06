import assert from 'node:assert/strict';
import test from 'node:test';
import { type Order } from '../src/lib/counterparty.js';
import {
  filterOrdersByStatus,
  getOrderStatusCounts,
  sortOrdersByNewest,
} from '../src/lib/orderHistory.js';

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    tx_hash: 'default_hash',
    source: '1source',
    give_asset: 'XCP',
    give_quantity: 100000000n,
    give_remaining: 100000000n,
    get_asset: 'PEPECASH',
    get_quantity: 1000n,
    get_remaining: 1000n,
    expiration: 1000,
    expire_index: 0,
    status: 'open',
    give_price: 0,
    get_price: 0,
    block_time: 0,
    ...overrides,
  };
}

test('getOrderStatusCounts returns totals from the unfiltered source set', () => {
  const counts = getOrderStatusCounts([
    buildOrder({ tx_hash: 'open-1', status: 'open' }),
    buildOrder({ tx_hash: 'filled-1', status: 'filled' }),
    buildOrder({ tx_hash: 'open-2', status: 'open' }),
    buildOrder({ tx_hash: 'cancelled-1', status: 'cancelled' }),
  ]);

  assert.deepEqual(counts, {
    open: 2,
    filled: 1,
    cancelled: 1,
    expired: 0,
  });
});

test('filterOrdersByStatus keeps all orders for the all filter', () => {
  const orders = [
    buildOrder({ tx_hash: 'open', status: 'open' }),
    buildOrder({ tx_hash: 'filled', status: 'filled' }),
  ];

  assert.equal(filterOrdersByStatus(orders, 'all').length, 2);
  assert.equal(filterOrdersByStatus(orders, 'filled')[0].tx_hash, 'filled');
});

test('sortOrdersByNewest sorts newest block time first', () => {
  const sorted = sortOrdersByNewest([
    buildOrder({ tx_hash: 'older', block_time: 100 }),
    buildOrder({ tx_hash: 'newer', block_time: 200 }),
  ]);

  assert.equal(sorted[0].tx_hash, 'newer');
  assert.equal(sorted[1].tx_hash, 'older');
});
