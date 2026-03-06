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
    getAllOpenOrders: async () => Object.values(ordersByAsset).flat(),
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
    getAllOpenOrders: async () => Object.values(ordersByAsset).flat(),
    getAssetDivisibility: async () => true,
  });

  assert.equal(matches.length, 0);
});

// ──────────────────────────────────────────────────────
// Buy-side tests (findBuyOpportunities)
// ──────────────────────────────────────────────────────

test('findBuyOpportunities finds order selling wishlist asset for user-held asset', async () => {
  // User holds XCP, wants RAREPEPE.
  // An order GIVES 100 RAREPEPE and GETS 200_000_000 base XCP (2 XCP).
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 500000000n }, // 5 XCP
  ];
  const wishlist = ['RAREPEPE'];

  const orders: Order[] = [
    buildOrder({
      tx_hash: 'sell1',
      give_asset: 'RAREPEPE',
      give_remaining: 100n,
      get_asset: 'XCP',
      get_remaining: 200000000n, // wants 2 XCP
    }),
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => orders,
    getAssetDivisibility: async (asset) => asset === 'XCP',
  });

  assert.equal(matches.length, 1);
  const [m] = matches;
  assert.equal(m.type, 'buy');
  assert.equal(m.asset, 'XCP');         // user pays with XCP
  assert.equal(m.getAsset, 'RAREPEPE'); // user receives RAREPEPE
  assert.equal(m.giveQuantityBase, 200000000n); // full 2 XCP (user can afford)
  assert.equal(m.getQuantityBase, 100n);         // full 100 RAREPEPE
});

test('findBuyOpportunities caps at user budget (partial fill)', async () => {
  // User holds only 1 XCP, order wants 2 XCP for 100 RAREPEPE → user can get 50
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 100000000n }, // 1 XCP
  ];
  const wishlist = ['RAREPEPE'];

  const orders: Order[] = [
    buildOrder({
      tx_hash: 'sell1',
      give_asset: 'RAREPEPE',
      give_remaining: 100n,
      get_asset: 'XCP',
      get_remaining: 200000000n, // 2 XCP
    }),
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => orders,
    getAssetDivisibility: async (asset) => asset === 'XCP',
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].giveQuantityBase, 100000000n); // only 1 XCP
  assert.equal(matches[0].getQuantityBase, 50n);          // 50 RAREPEPE
});

test('findBuyOpportunities filters orders wanting assets user does not hold', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 500000000n },
  ];
  const wishlist = ['RAREPEPE'];

  // This order sells RAREPEPE but wants PEPECASH, which user doesn't hold
  const orders: Order[] = [
    buildOrder({
      tx_hash: 'sell2',
      give_asset: 'RAREPEPE',
      give_remaining: 100n,
      get_asset: 'PEPECASH',
      get_remaining: 5000n,
    }),
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => orders,
    getAssetDivisibility: async () => true,
  });

  assert.equal(matches.length, 0);
});

test('findBuyOpportunities returns empty for empty wishlist', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 500000000n },
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities([], balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => [
      buildOrder({ give_asset: 'RAREPEPE', get_asset: 'XCP' }),
    ],
    getAssetDivisibility: async () => true,
  });

  assert.equal(matches.length, 0);
});

test('findBuyOpportunities sorts by cheapest price first', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 1000000000n }, // 10 XCP
  ];
  const wishlist = ['RAREPEPE'];

  const orders: Order[] = [
    buildOrder({
      tx_hash: 'expensive',
      give_asset: 'RAREPEPE',
      give_remaining: 10n,
      get_asset: 'XCP',
      get_remaining: 500000000n, // 5 XCP for 10 → 0.5 XCP each (expensive)
    }),
    buildOrder({
      tx_hash: 'cheap',
      give_asset: 'RAREPEPE',
      give_remaining: 100n,
      get_asset: 'XCP',
      get_remaining: 100000000n, // 1 XCP for 100 → 0.01 XCP each (cheap)
    }),
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => orders,
    getAssetDivisibility: async (asset) => asset === 'XCP',
  });

  assert.equal(matches.length, 2);
  assert.equal(matches[0].order.tx_hash, 'cheap');     // cheapest first
  assert.equal(matches[1].order.tx_hash, 'expensive');
});

test('findBuyOpportunities filters closed orders', async () => {
  const balances: Balance[] = [
    { address: '1wallet', asset: 'XCP', quantity: 500000000n },
  ];
  const wishlist = ['RAREPEPE'];

  const orders: Order[] = [
    buildOrder({
      tx_hash: 'closed1',
      give_asset: 'RAREPEPE',
      give_remaining: 100n,
      get_asset: 'XCP',
      get_remaining: 200000000n,
      status: 'filled',
    }),
    buildOrder({
      tx_hash: 'zero1',
      give_asset: 'RAREPEPE',
      give_remaining: 0n,
      get_asset: 'XCP',
      get_remaining: 200000000n,
    }),
  ];

  const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances, {
    getOrdersForAsset: async () => [],
    getAllOpenOrders: async () => orders,
    getAssetDivisibility: async () => true,
  });

  assert.equal(matches.length, 0);
});

