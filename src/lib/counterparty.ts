/**
 * Counterparty Core API v2 Client
 * Production: https://api.counterparty.io:4000
 */

const API_BASE = 'https://api.counterparty.io:4000/v2';

export interface Order {
  tx_hash: string;
  source: string;
  give_asset: string;
  give_quantity: number;
  give_remaining: number;
  get_asset: string;
  get_quantity: number;
  get_remaining: number;
  expiration: number;
  expire_index: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  give_price: number;
  get_price: number;
  block_time: number;
  give_quantity_normalized?: string;
  get_quantity_normalized?: string;
}

export interface Balance {
  address: string;
  asset: string;
  quantity: number;
  quantity_normalized?: string;
}

export interface ComposeResult {
  rawtransaction: string;
  params: Record<string, unknown>;
  name: string;
  psbt?: string;
}

export interface MempoolEvent {
  tx_hash: string;
  event: string;
  params: Record<string, unknown>;
  timestamp: number;
}

/**
 * Get order book for a trading pair
 */
export async function getOrders(
  asset1: string,
  asset2: string,
  status: 'open' | 'all' = 'open'
): Promise<Order[]> {
  const url = `${API_BASE}/orders/${asset1}/${asset2}?status=${status}&verbose=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch orders: ${res.statusText}`);
  const data = await res.json();
  return data.result || [];
}

/**
 * Get balances for an address
 */
export async function getBalances(address: string): Promise<Balance[]> {
  const url = `${API_BASE}/addresses/${address}/balances?verbose=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch balances: ${res.statusText}`);
  const data = await res.json();
  return data.result || [];
}

/**
 * Compose an order transaction (returns unsigned tx hex)
 */
export async function composeOrder(params: {
  address: string;
  give_asset: string;
  give_quantity: number;
  get_asset: string;
  get_quantity: number;
  expiration: number;
  fee_required?: number;
}): Promise<ComposeResult> {
  const queryParams = new URLSearchParams({
    give_asset: params.give_asset,
    give_quantity: params.give_quantity.toString(),
    get_asset: params.get_asset,
    get_quantity: params.get_quantity.toString(),
    expiration: params.expiration.toString(),
    fee_required: (params.fee_required ?? 0).toString(),
    verbose: 'true',
  });
  
  const url = `${API_BASE}/addresses/${params.address}/compose/order?${queryParams}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to compose order: ${res.statusText}`);
  const data = await res.json();
  return data.result;
}

/**
 * Get mempool events for front-run protection
 */
export async function getMempoolEvents(addresses?: string[]): Promise<MempoolEvent[]> {
  let url = `${API_BASE}/mempool/events?verbose=true`;
  if (addresses?.length) {
    url += `&addresses=${addresses.join(',')}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch mempool: ${res.statusText}`);
  const data = await res.json();
  return data.result || [];
}

/**
 * Broadcast a signed transaction
 */
export async function broadcastTransaction(signedHex: string): Promise<string> {
  const url = `${API_BASE}/bitcoin/transactions?signedhex=${encodeURIComponent(signedHex)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to broadcast: ${res.statusText}`);
  const data = await res.json();
  return data.result?.tx_hash || data.result;
}

export interface MarketPair {
  quote: string;
  orderCount: number;
}

/**
 * Get all active markets (pairs with open orders) for a base asset
 * Fetches orders for the base asset and aggregates unique quote assets
 */
/**
 * Get raw open orders involving a specific asset (either giving or receiving)
 */
export async function getOrdersForAsset(asset: string, status: 'open' | 'all' = 'open'): Promise<Order[]> {
  try {
    const url = `${API_BASE}/assets/${asset}/orders?status=${status}&verbose=true`;
    const res = await fetch(url);
    if (!res.ok) return [];
    
    const data = await res.json();
    return data.result || [];
  } catch (e) {
    console.error(`Error fetching orders for ${asset}:`, e);
    return [];
  }
}

/**
 * Get all active markets (pairs with open orders) for a base asset
 * Fetches orders for the base asset and aggregates unique quote assets
 */
export async function getMarketsForBase(baseAsset: string): Promise<MarketPair[]> {
  try {
    // Get all open orders where this asset is being given or received
    const orders = await getOrdersForAsset(baseAsset);
    
    // Count orders per quote asset
    const pairCounts = new Map<string, number>();
    
    for (const order of orders) {
      // Determine which asset is the "quote" (the other side of the trade)
      const quote = order.give_asset === baseAsset ? order.get_asset : order.give_asset;
      pairCounts.set(quote, (pairCounts.get(quote) || 0) + 1);
    }
    
    // Convert to array and sort by order count
    const markets: MarketPair[] = Array.from(pairCounts.entries())
      .map(([quote, orderCount]) => ({ quote, orderCount }))
      .sort((a, b) => b.orderCount - a.orderCount);
    
    return markets;
  } catch {
    return [];
  }
}

// Popular base assets for quick selection
export const POPULAR_BASES = ['XCP', 'BTC', 'PEPECASH', 'RAREPEPE'];
