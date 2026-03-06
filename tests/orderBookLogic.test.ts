/**
 * Unit tests for OrderBook logic: ask/bid splitting, sorting, sweep sets.
 *
 * These test the pure algorithmic logic that the OrderBook component relies on,
 * without requiring a DOM or React rendering.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order } from '../src/lib/counterparty.js';
import { calculatePrice, formatBaseUnits } from '../src/lib/quantity.js';

// ─── Helpers ────────────────────────────────────────

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

// Replicate the OrderBook's splitting logic
function splitOrders(orders: Order[], asset1: string, isDivisible: (a: string) => boolean) {
  const asks = orders
    .filter(o => o.give_asset === asset1 && o.status === 'open')
    .sort((a, b) => {
      const priceA = calculatePrice(a.get_quantity, isDivisible(a.get_asset), a.give_quantity, isDivisible(a.give_asset));
      const priceB = calculatePrice(b.get_quantity, isDivisible(b.get_asset), b.give_quantity, isDivisible(b.give_asset));
      return priceA - priceB;
    });

  const bids = orders
    .filter(o => o.get_asset === asset1 && o.status === 'open')
    .sort((a, b) => {
      const priceA = calculatePrice(a.give_quantity, isDivisible(a.give_asset), a.get_quantity, isDivisible(a.get_asset));
      const priceB = calculatePrice(b.give_quantity, isDivisible(b.give_asset), b.get_quantity, isDivisible(b.get_asset));
      return priceB - priceA;
    });

  return { asks, bids };
}

// Replicate sweep set logic
function getSweepSet(hoveredOrder: Order, asks: Order[], bids: Order[], asset1: string) {
  const isAsk = hoveredOrder.give_asset === asset1;
  const list = isAsk ? asks : bids;
  const index = list.indexOf(hoveredOrder);
  if (index === -1) return [];
  return list.slice(0, index + 1);
}

// Replicate sweep stats logic
function getSweepStats(
  sweepSet: Order[],
  asset1: string,
  asset2: string,
  isDivisible: (a: string) => boolean,
) {
  if (sweepSet.length === 0) return null;
  const count = sweepSet.length;
  let totalGive = 0n;
  let totalGet = 0n;
  sweepSet.forEach(o => { totalGive += o.give_remaining; totalGet += o.get_remaining; });
  const isAsk = sweepSet[0].give_asset === asset1;
  const avgPrice = isAsk
    ? calculatePrice(totalGet, isDivisible(asset2), totalGive, isDivisible(asset1))
    : calculatePrice(totalGive, isDivisible(asset2), totalGet, isDivisible(asset1));
  const getDisplay = isAsk
    ? formatBaseUnits(totalGive, isDivisible(asset1))
    : formatBaseUnits(totalGet, isDivisible(asset1));
  const payDisplay = isAsk
    ? formatBaseUnits(totalGet, isDivisible(asset2))
    : formatBaseUnits(totalGive, isDivisible(asset2));
  return { count, avgPrice, isAsk, getDisplay, payDisplay };
}

// ─── Tests ────────────────────────────────────────

const div = (a: string) => a === 'XCP' || a === 'BTC';

test('splitOrders separates asks from bids by asset1', () => {
  const orders = [
    buildOrder({ tx_hash: 'ask1', give_asset: 'XCP', get_asset: 'PEPECASH' }),
    buildOrder({ tx_hash: 'bid1', give_asset: 'PEPECASH', get_asset: 'XCP' }),
    buildOrder({ tx_hash: 'ask2', give_asset: 'XCP', get_asset: 'PEPECASH' }),
  ];
  const { asks, bids } = splitOrders(orders, 'XCP', div);
  assert.equal(asks.length, 2);
  assert.equal(bids.length, 1);
  assert.ok(asks.every(a => a.give_asset === 'XCP'));
  assert.ok(bids.every(b => b.get_asset === 'XCP'));
});

test('splitOrders excludes non-open orders', () => {
  const orders = [
    buildOrder({ tx_hash: 'open1', give_asset: 'XCP', status: 'open' }),
    buildOrder({ tx_hash: 'filled1', give_asset: 'XCP', status: 'filled' }),
    buildOrder({ tx_hash: 'cancelled1', give_asset: 'XCP', status: 'cancelled' }),
    buildOrder({ tx_hash: 'expired1', give_asset: 'XCP', status: 'expired' }),
  ];
  const { asks } = splitOrders(orders, 'XCP', div);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].tx_hash, 'open1');
});

test('asks are sorted cheapest first (ascending price)', () => {
  // Expensive: 2 XCP for 100 PEPE (price = 50 PEPE/XCP)
  // Cheap: 1 XCP for 200 PEPE (price = 200 PEPE/XCP)
  // But price in OrderBook is get_quantity/give_quantity context
  const orders = [
    buildOrder({
      tx_hash: 'expensive',
      give_asset: 'XCP',
      give_quantity: 200000000n, // 2 XCP
      get_asset: 'PEPECASH',
      get_quantity: 10000n,      // 10000 PEPE
    }),
    buildOrder({
      tx_hash: 'cheap',
      give_asset: 'XCP',
      give_quantity: 100000000n,  // 1 XCP
      get_asset: 'PEPECASH',
      get_quantity: 5000n,        // 5000 PEPE (same ratio but smaller)
    }),
  ];
  const { asks } = splitOrders(orders, 'XCP', div);
  assert.equal(asks.length, 2);
  // Both have same unit price (5000 PEPE per XCP), so order is stable
  // Let's test with different prices
  const orders2 = [
    buildOrder({
      tx_hash: 'expensive',
      give_asset: 'XCP',
      give_quantity: 100000000n, // 1 XCP
      get_asset: 'PEPECASH',
      get_quantity: 10000n,      // wants 10000 PEPE
    }),
    buildOrder({
      tx_hash: 'cheap',
      give_asset: 'XCP',
      give_quantity: 100000000n,  // 1 XCP
      get_asset: 'PEPECASH',
      get_quantity: 5000n,        // wants only 5000 PEPE (cheaper for buyer)
    }),
  ];
  const { asks: asks2 } = splitOrders(orders2, 'XCP', div);
  assert.equal(asks2[0].tx_hash, 'cheap');
  assert.equal(asks2[1].tx_hash, 'expensive');
});

test('bids are sorted highest first (descending price)', () => {
  const orders = [
    buildOrder({
      tx_hash: 'low_bid',
      give_asset: 'PEPECASH',
      give_quantity: 1000n,
      get_asset: 'XCP',
      get_quantity: 100000000n,  // wants 1 XCP for 1000 PEPE
    }),
    buildOrder({
      tx_hash: 'high_bid',
      give_asset: 'PEPECASH',
      give_quantity: 5000n,
      get_asset: 'XCP',
      get_quantity: 100000000n,  // offers 5000 PEPE for 1 XCP
    }),
  ];
  const { bids } = splitOrders(orders, 'XCP', div);
  assert.equal(bids[0].tx_hash, 'high_bid');
  assert.equal(bids[1].tx_hash, 'low_bid');
});

test('getSweepSet returns orders up to and including hovered order', () => {
  const ask1 = buildOrder({ tx_hash: 'a1', give_asset: 'XCP' });
  const ask2 = buildOrder({ tx_hash: 'a2', give_asset: 'XCP' });
  const ask3 = buildOrder({ tx_hash: 'a3', give_asset: 'XCP' });
  const asks = [ask1, ask2, ask3];

  const sweep = getSweepSet(ask2, asks, [], 'XCP');
  assert.equal(sweep.length, 2);
  assert.equal(sweep[0].tx_hash, 'a1');
  assert.equal(sweep[1].tx_hash, 'a2');
});

test('getSweepSet returns empty if order not in list', () => {
  const ask1 = buildOrder({ tx_hash: 'a1', give_asset: 'XCP' });
  const orphan = buildOrder({ tx_hash: 'orphan', give_asset: 'XCP' });
  const sweep = getSweepSet(orphan, [ask1], [], 'XCP');
  assert.equal(sweep.length, 0);
});

test('getSweepStats calculates aggregate totals and average price', () => {
  const sweep = [
    buildOrder({
      tx_hash: 'a1',
      give_asset: 'XCP',
      give_remaining: 100000000n,  // 1 XCP
      get_remaining: 5000n,
    }),
    buildOrder({
      tx_hash: 'a2',
      give_asset: 'XCP',
      give_remaining: 200000000n,  // 2 XCP
      get_remaining: 15000n,
    }),
  ];

  const stats = getSweepStats(sweep, 'XCP', 'PEPECASH', div);
  assert.ok(stats !== null);
  assert.equal(stats!.count, 2);
  assert.equal(stats!.isAsk, true);
  // Total give: 3 XCP (300000000n), total get: 20000 PEPE
  assert.equal(stats!.getDisplay, '3'); // 3 XCP (formatBaseUnits trims trailing zeros)
  assert.equal(stats!.payDisplay, '20,000');        // 20000 PEPECASH (indivisible, locale-formatted)
});

test('getSweepStats returns null for empty sweep', () => {
  assert.equal(getSweepStats([], 'XCP', 'PEPECASH', div), null);
});
