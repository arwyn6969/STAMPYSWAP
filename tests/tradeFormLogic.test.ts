/**
 * Unit tests for TradeForm logic: spread warning detection, validation.
 *
 * Tests the spread-warning algorithm that detects when a user's order
 * is significantly worse than the current market rate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order } from '../src/lib/counterparty.js';

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

/**
 * Replicates the TradeForm spread warning logic.
 * This is the exact algorithm from TradeForm.tsx's `spreadWarning` useMemo.
 */
function getSpreadWarning(
  orders: Order[],
  giveAsset: string,
  getAsset: string,
  giveQuantity: string,
  getQuantity: string,
  giveDivisible: boolean,
  getDivisible: boolean,
): { level: string; message: string } | null {
  if (!orders || orders.length === 0) return null;
  if (!giveAsset || !getAsset || !giveQuantity || !getQuantity) return null;

  const opposingOrders = orders.filter(
    (o) => o.give_asset === getAsset && o.get_asset === giveAsset && o.status === 'open',
  );

  if (opposingOrders.length === 0) return null;

  let best = 0;
  for (const o of opposingOrders) {
    const theirGive = Number(o.give_remaining) / (getDivisible ? 1e8 : 1);
    const theirGet = Number(o.get_remaining) / (giveDivisible ? 1e8 : 1);
    const rate = theirGive / theirGet;
    if (rate > best) best = rate;
  }

  if (best <= 0) return null;

  const userGive = parseFloat(giveQuantity);
  const userGet = parseFloat(getQuantity);
  if (!userGive || !userGet) return null;

  const userRate = userGet / userGive;

  if (userRate < best) {
    const worseByPercent = ((best - userRate) / best) * 100;
    if (worseByPercent > 20) {
      return {
        level: 'danger',
        message: `DANGER: You are bidding ${worseByPercent.toFixed(1)}% worse than the current market floor!`,
      };
    } else if (worseByPercent > 10) {
      return {
        level: 'warning',
        message: `Warning: You are bidding ${worseByPercent.toFixed(1)}% worse than the current market spread.`,
      };
    }
  }

  return null;
}

// ─── Tests ────────────────────────────────────────

test('spread warning returns null when no orders exist', () => {
  assert.equal(getSpreadWarning([], 'XCP', 'PEPECASH', '1', '100', true, false), null);
});

test('spread warning returns null when no opposing orders', () => {
  // User gives XCP, gets PEPECASH. An order that gives XCP (same side) is not opposing.
  const orders = [
    buildOrder({ give_asset: 'XCP', get_asset: 'PEPECASH', status: 'open' }),
  ];
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '100', true, false);
  assert.equal(result, null);
});

test('spread warning returns null when fields are empty', () => {
  const orders = [
    buildOrder({ give_asset: 'PEPECASH', get_asset: 'XCP', give_remaining: 1000n, get_remaining: 100000000n, status: 'open' }),
  ];
  assert.equal(getSpreadWarning(orders, 'XCP', 'PEPECASH', '', '100', true, false), null);
  assert.equal(getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '', true, false), null);
  assert.equal(getSpreadWarning(orders, '', 'PEPECASH', '1', '100', true, false), null);
  assert.equal(getSpreadWarning(orders, 'XCP', '', '1', '100', true, false), null);
});

test('spread warning returns null when user bid is at market rate', () => {
  // Market: someone gives 1000 PEPE for 1 XCP → rate = 1000/1 = 1000
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 1000n,       // 1000 PEPE (indivisible)
      get_remaining: 100000000n,   // 1 XCP
      status: 'open',
    }),
  ];
  // User bids: give 1 XCP, get 1000 PEPE → rate = 1000/1 = 1000 (matches market)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '1000', true, false);
  assert.equal(result, null);
});

test('spread warning returns danger when bid is >20% worse', () => {
  // Market: someone gives 1000 PEPE for 1 XCP → best rate = 1000
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 1000n,
      get_remaining: 100000000n,
      status: 'open',
    }),
  ];
  // User bids: give 1 XCP, get only 500 PEPE → rate = 500 (50% worse)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '500', true, false);
  assert.ok(result !== null);
  assert.equal(result!.level, 'danger');
  assert.ok(result!.message.includes('50.0%'));
});

test('spread warning returns warning when bid is 10-20% worse', () => {
  // Market rate = 1000
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 1000n,
      get_remaining: 100000000n,
      status: 'open',
    }),
  ];
  // User rate = 850 (15% worse)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '850', true, false);
  assert.ok(result !== null);
  assert.equal(result!.level, 'warning');
  assert.ok(result!.message.includes('15.0%'));
});

test('spread warning returns null when bid is only slightly worse (<10%)', () => {
  // Market rate = 1000
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 1000n,
      get_remaining: 100000000n,
      status: 'open',
    }),
  ];
  // User rate = 950 (5% worse — below threshold)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '950', true, false);
  assert.equal(result, null);
});

test('spread warning returns null when user bid is BETTER than market', () => {
  // Market rate = 1000
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 1000n,
      get_remaining: 100000000n,
      status: 'open',
    }),
  ];
  // User rate = 1200 (better than market — user is overpaying)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '1200', true, false);
  assert.equal(result, null);
});

test('spread warning picks best market rate from multiple orders', () => {
  const orders = [
    buildOrder({
      tx_hash: 'bad_offer',
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 500n,
      get_remaining: 100000000n,
      status: 'open',
    }),
    buildOrder({
      tx_hash: 'good_offer',
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 2000n,
      get_remaining: 100000000n,
      status: 'open',
    }),
  ];
  // Best market rate = 2000 (from good_offer)
  // User rate = 1500 (25% worse than best)
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '1500', true, false);
  assert.ok(result !== null);
  assert.equal(result!.level, 'danger');
  assert.ok(result!.message.includes('25.0%'));
});

test('spread warning ignores non-open opposing orders', () => {
  const orders = [
    buildOrder({
      give_asset: 'PEPECASH',
      get_asset: 'XCP',
      give_remaining: 5000n,
      get_remaining: 100000000n,
      status: 'filled',  // Not open!
    }),
  ];
  // No open opposing orders → null
  const result = getSpreadWarning(orders, 'XCP', 'PEPECASH', '1', '100', true, false);
  assert.equal(result, null);
});
