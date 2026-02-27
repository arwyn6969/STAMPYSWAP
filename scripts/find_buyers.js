#!/usr/bin/env node
/**
 * Find open DEX orders to buy assets you own
 *
 * Usage: node find_buyers.js <ADDRESS>
 */

import axios from 'axios';

const COUNTERPARTY_API = process.env.COUNTERPARTY_API || 'https://api.counterparty.io:4000/v2';

async function fetchAllPages(endpoint, params = {}) {
  const results = [];
  let cursor = null;
  const limit = 1000;

  while (true) {
    const searchParams = new URLSearchParams({
      ...params,
      limit: String(limit),
      ...(cursor && { cursor: String(cursor) }),
    });

    const response = await axios.get(`${COUNTERPARTY_API}${endpoint}?${searchParams}`);
    const data = response.data;

    if (data.result) {
      results.push(...data.result);
    }

    if (!data.next_cursor || (data.result && data.result.length < limit)) {
      break;
    }
    cursor = data.next_cursor;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  return results;
}

async function getBalances(address) {
  console.log('Fetching balances...');
  const balances = await fetchAllPages(`/addresses/${address}/balances`, { verbose: 'true' });

  // Build a map of asset -> balance info
  const assetMap = new Map();
  for (const b of balances) {
    const assetName = b.asset_longname || b.asset;
    const existing = assetMap.get(assetName);
    if (existing) {
      existing.quantity += BigInt(b.quantity);
    } else {
      assetMap.set(assetName, {
        asset: assetName,
        quantity: BigInt(b.quantity),
        divisible: b.asset_info?.divisible ?? false,
        quantityNormalized: b.quantity_normalized,
      });
    }
  }

  return assetMap;
}

async function getAllOpenOrders() {
  console.log('Fetching all open orders...');
  return fetchAllPages('/orders', { status: 'open', verbose: 'true' });
}

function formatQuantity(quantity, divisible) {
  if (divisible) {
    return (Number(quantity) / 100000000).toFixed(8).replace(/\.?0+$/, '');
  }
  return quantity.toString();
}

async function main() {
  const address = process.argv[2];

  if (!address) {
    console.log('Usage: node find_buyers.js <ADDRESS>');
    console.log('Example: node find_buyers.js 19QWXpMXeLkoEKEJv2xo9rn8wkPCyxACSX');
    process.exit(1);
  }

  console.log(`\nFinding buyers for assets owned by: ${address}\n`);

  // Get balances
  const balances = await getBalances(address);
  console.log(`Found ${balances.size} unique assets in wallet\n`);

  // Get all open orders
  const orders = await getAllOpenOrders();
  console.log(`Found ${orders.length} total open orders\n`);

  // Filter orders where get_asset is something we own
  // (someone wants to buy what we have)
  // Exclude BTC orders (usually spam/dust)
  const buyOrders = orders.filter(order => {
    const getAsset = order.get_asset_info?.asset_longname || order.get_asset;
    const giveAsset = order.give_asset_info?.asset_longname || order.give_asset;
    return balances.has(getAsset) && order.source !== address && giveAsset !== 'BTC';
  });

  if (buyOrders.length === 0) {
    console.log('No open orders found to buy your assets.');
    return;
  }

  console.log(`Found ${buyOrders.length} orders to buy assets you own:\n`);
  console.log('='.repeat(80));

  // Group by asset being bought
  const byAsset = new Map();
  for (const order of buyOrders) {
    const getAsset = order.get_asset_info?.asset_longname || order.get_asset;
    if (!byAsset.has(getAsset)) {
      byAsset.set(getAsset, []);
    }
    byAsset.get(getAsset).push(order);
  }

  // Sort assets by number of orders (most orders first)
  const sortedAssets = [...byAsset.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [asset, assetOrders] of sortedAssets) {
    const balance = balances.get(asset);
    const yourQty = formatQuantity(balance.quantity, balance.divisible);

    console.log(`\n${asset} (you have: ${yourQty})`);
    console.log('-'.repeat(80));

    // Sort orders by price (best price first - most give per get)
    assetOrders.sort((a, b) => {
      const priceA = Number(a.give_quantity) / Number(a.get_quantity);
      const priceB = Number(b.give_quantity) / Number(b.get_quantity);
      return priceB - priceA;
    });

    for (const order of assetOrders) {
      const giveAsset = order.give_asset_info?.asset_longname || order.give_asset;
      const giveQty = formatQuantity(order.give_quantity, order.give_asset_info?.divisible);
      const getQty = formatQuantity(order.get_quantity, order.get_asset_info?.divisible);
      const giveRemaining = formatQuantity(order.give_remaining, order.give_asset_info?.divisible);
      const getRemaining = formatQuantity(order.get_remaining, order.get_asset_info?.divisible);

      // Calculate unit price
      const unitPrice = (Number(order.give_quantity) / Number(order.get_quantity));
      const priceDisplay = order.give_asset_info?.divisible
        ? (unitPrice / 100000000).toFixed(8).replace(/\.?0+$/, '')
        : unitPrice.toFixed(8).replace(/\.?0+$/, '');

      const filled = order.give_quantity !== order.give_remaining ? ' (partial)' : '';

      console.log(`  Buying ${getRemaining} ${asset} for ${giveRemaining} ${giveAsset}${filled}`);
      console.log(`    Price: ${priceDisplay} ${giveAsset}/${asset} | From: ${order.source.slice(0, 12)}...`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`\nSummary: ${buyOrders.length} buy orders across ${byAsset.size} of your assets`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
