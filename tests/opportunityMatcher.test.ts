import assert from 'node:assert/strict';
import test from 'node:test';
import { OpportunityMatcher } from '../src/lib/agent/OpportunityMatcher.js';
import type { Balance, Order } from '../src/lib/counterparty.js';

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    tx_hash: 'abc123',
    source: '1source',
    give_asset: 'XCP',
    give_quantity: 200000000n,
    give_remaining: 200000000n,
    get_asset: 'RAREPEPE',
    get_quantity: 100n,
    get_remaining: 100n,
    expiration: 1000,
    expire_index: 0,
    status: 'open',
    give_price: 0,
    get_price: 0,
    block_time: 0,
    ...overrides,
  };
}

test('findMatches creates partial-fill opportunities based on wallet balance', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'RAREPEPE', quantity: 40n },
  ];

  const ordersByAsset: Record<string, Order[]> = {
    RAREPEPE: [
      buildOrder({
        tx_hash: 'order1',
        give_asset: 'XCP',
        give_remaining: 200000000n, // 2 XCP
        get_asset: 'RAREPEPE',
        get_remaining: 100n, // Wants 100 units
      }),
    ],
  };

  const divisibility: Record<string, boolean> = {
    RAREPEPE: false,
    XCP: true,
  };

  const matches = await OpportunityMatcher.findMatches(balances, {
    getOrdersForAsset: async (asset) => ordersByAsset[asset] ?? [],
    getAssetDivisibility: async (asset) => divisibility[asset] ?? true,
  });

  assert.equal(matches.length, 1);
  const [match] = matches;
  assert.equal(match.asset, 'RAREPEPE');
  assert.equal(match.getAsset, 'XCP');
  assert.equal(match.giveQuantityBase, 40n); // limited by wallet balance
  assert.equal(match.getQuantityBase, 80000000n); // 40% of 2 XCP
  assert.equal(match.quantity, 40);
  assert.equal(match.expectedReturn, 0.8);
  assert.equal(match.price, 0.02); // 0.8 XCP / 40
});

test('findMatches filters closed or incompatible orders', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'RAREPEPE', quantity: 10n },
  ];

  const ordersByAsset: Record<string, Order[]> = {
    RAREPEPE: [
      buildOrder({ tx_hash: 'closed', status: 'filled' }),
      buildOrder({ tx_hash: 'wrong-asset', get_asset: 'XCP' }),
      buildOrder({ tx_hash: 'zero', get_remaining: 0n }),
    ],
  };

  const matches = await OpportunityMatcher.findMatches(balances, {
    getOrdersForAsset: async (asset) => ordersByAsset[asset] ?? [],
    getAssetDivisibility: async () => true,
  });

  assert.equal(matches.length, 0);
});
