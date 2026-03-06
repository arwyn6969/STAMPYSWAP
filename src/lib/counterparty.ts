/**
 * Counterparty Core API v2 Client
 * Production: https://api.counterparty.io:4000
 */

let API_BASE = 'https://api.counterparty.io:4000/v2';

export function getIsTestnet(): boolean {
  return API_BASE.includes('testnet');
}

export function setTestnet(isTestnet: boolean) {
  API_BASE = isTestnet 
    ? 'https://testnet.counterparty.io:4000/v2' 
    : 'https://api.counterparty.io:4000/v2';
    
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem('STAMPYSWAP_TESTNET', isTestnet ? 'true' : 'false');
    } catch {
      // Ignored
    }
  }
}

// Initialize from local storage
if (typeof window !== 'undefined') {
  try {
    if (window.localStorage.getItem('STAMPYSWAP_TESTNET') === 'true') {
      setTestnet(true);
    }
  } catch {
    // Ignored
  }
}
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;
const DEFAULT_DIVISIBLE_ASSETS = new Set(['BTC', 'XCP']);

type JsonObject = Record<string, unknown>;
type BaseUnitsLike = bigint | number | string;

export interface Order {
  tx_hash: string;
  source: string;
  give_asset: string;
  give_quantity: bigint;
  give_remaining: bigint;
  get_asset: string;
  get_quantity: bigint;
  get_remaining: bigint;
  expiration: number;
  expire_index: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  give_price: number;
  get_price: number;
  block_time: number;
  give_quantity_normalized?: string;
  get_quantity_normalized?: string;
  give_remaining_normalized?: string;
  get_remaining_normalized?: string;
  is_dispenser?: boolean;
}

export interface Balance {
  address: string;
  asset: string;
  quantity: bigint;
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

export type TransactionStatus = 'mempool' | 'confirmed' | 'failed' | 'unknown';

export interface TransactionState {
  txid: string;
  status: TransactionStatus;
  confirmations: number;
  blockHeight?: number;
  blockTime?: number;
  source: 'counterparty' | 'mempool.space' | 'blockstream';
}

export interface AssetInfo {
  asset: string;
  divisible: boolean;
  supply?: number;
  description?: string;
  issuer?: string;
  locked?: boolean;
}

/**
 * Get order book for a trading pair
 */
export async function getOrders(
  asset1: string,
  asset2: string,
  status: 'open' | 'all' = 'open'
): Promise<Order[]> {
  const norm1 = asset1.trim().toUpperCase();
  const norm2 = asset2.trim().toUpperCase();

  const orders = await requestCounterparty(
    `/orders/${encodeURIComponent(asset1)}/${encodeURIComponent(asset2)}?status=${status}&verbose=true`,
    parseOrders,
  );
  
  // Mix in dispensers!
  let dispensers: Order[] = [];
  if (norm1 === 'BTC' && norm2 !== 'BTC') {
    dispensers = await getDispensersAsOrders(norm2, status);
    // Dispenser is selling norm2 for BTC, meaning it "gives" norm2 and "gets" BTC
    // But since the query was order(BTC, norm2), we only show open orders if they match the pair. Wait, getOrders fetches all orders for the PAIR, regardless of direction. 
    // The query `/orders/BTC/PEPECASH` returns both BTC->PEPE and PEPE->BTC orders.
  } else if (norm2 === 'BTC' && norm1 !== 'BTC') {
    dispensers = await getDispensersAsOrders(norm1, status);
  }

  return [...orders, ...dispensers];
}

/**
 * Get balances for an address
 */
export async function getBalances(address: string): Promise<Balance[]> {
  return requestCounterparty(
    `/addresses/${encodeURIComponent(address)}/balances?verbose=true`,
    parseBalances,
  );
}

/**
 * Get all orders placed by a specific address (open, filled, cancelled, expired)
 */
export async function getUserOrders(
  address: string,
  status: 'open' | 'filled' | 'cancelled' | 'expired' | 'all' = 'all',
): Promise<Order[]> {
  const statusParam = status === 'all' ? 'all' : status;
  return requestCounterparty(
    `/addresses/${encodeURIComponent(address)}/orders?status=${statusParam}&verbose=true`,
    parseOrders,
  );
}

/**
 * Compose an order transaction (returns unsigned tx hex)
 */
export async function composeOrder(params: {
  address: string;
  give_asset: string;
  give_quantity: BaseUnitsLike;
  get_asset: string;
  get_quantity: BaseUnitsLike;
  expiration: number;
  fee_required?: BaseUnitsLike;
}): Promise<ComposeResult> {
  const queryParams = new URLSearchParams({
    give_asset: params.give_asset,
    give_quantity: serializeBaseUnits(params.give_quantity, 'give_quantity'),
    get_asset: params.get_asset,
    get_quantity: serializeBaseUnits(params.get_quantity, 'get_quantity'),
    expiration: params.expiration.toString(),
    fee_required: serializeBaseUnits(params.fee_required ?? 0n, 'fee_required'),
    verbose: 'true',
  });
  
  return requestCounterparty(
    `/addresses/${encodeURIComponent(params.address)}/compose/order?${queryParams}`,
    parseComposeResult,
  );
}

/**
 * Get mempool events for front-run protection
 */
export async function getMempoolEvents(addresses?: string[]): Promise<MempoolEvent[]> {
  let url = `${API_BASE}/mempool/events?verbose=true`;
  if (addresses?.length) {
    url += `&addresses=${addresses.join(',')}`;
  }
  return requestCounterparty(url.replace(API_BASE, ''), parseMempoolEvents);
}

/**
 * Broadcast a signed transaction
 */
export async function broadcastTransaction(signedHex: string): Promise<string> {
  return requestCounterparty(
    `/bitcoin/transactions?signedhex=${encodeURIComponent(signedHex)}`,
    (result) => {
      if (typeof result === 'string') return result;
      if (isJsonObject(result) && typeof result.tx_hash === 'string') return result.tx_hash;
      throw new Error('Counterparty broadcast response did not include a tx hash');
    },
  );
}

/**
 * Get transaction confirmation status with resilient explorer fallback.
 */
export async function getTransactionStatus(txid: string): Promise<TransactionState> {
  const normalizedTxid = txid.trim();
  if (!normalizedTxid) {
    throw new Error('Transaction ID is required');
  }

  try {
    return await requestCounterparty(
      `/bitcoin/transactions/${encodeURIComponent(normalizedTxid)}?verbose=true`,
      (result) => parseCounterpartyTransactionState(result, normalizedTxid),
    );
  } catch {
    // Fallback to public explorers below.
  }

  try {
    return await getExplorerTransactionState(
      'mempool.space',
      `https://mempool.space/api/tx/${encodeURIComponent(normalizedTxid)}/status`,
      'https://mempool.space/api/blocks/tip/height',
      normalizedTxid,
    );
  } catch {
    return getExplorerTransactionState(
      'blockstream',
      `https://blockstream.info/api/tx/${encodeURIComponent(normalizedTxid)}/status`,
      'https://blockstream.info/api/blocks/tip/height',
      normalizedTxid,
    );
  }
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
    return await requestCounterparty(
      `/assets/${encodeURIComponent(asset)}/orders?status=${status}&verbose=true`,
      parseOrders,
    );
  } catch (e) {
    console.error(`Error fetching orders for ${asset}:`, e);
    return [];
  }
}

/**
 * Get all open orders across the entire DEX
 */
export async function getAllOpenOrders(): Promise<Order[]> {
  const allOrders: Order[] = [];
  let cursor: string | undefined;
  const limit = 1000;

  while (true) {
    let url = `${API_BASE}/orders?status=open&verbose=true&limit=${limit}`;
    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      
      if (payload.result) {
        allOrders.push(...parseOrders(payload.result));
      }
      
      if (!payload.next_cursor || (payload.result && payload.result.length < limit)) {
        break;
      }
      cursor = payload.next_cursor;
      
      // Delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error("Failed to fetch page of all open orders:", err);
      break; 
    }
  }

  return allOrders;
}

/**
 * Fetch open dispensers for an asset and shape them as Orders
 */
export async function getDispensersAsOrders(asset: string, status: 'open' | 'all' = 'open'): Promise<Order[]> {
  try {
    const statusQuery = status === 'open' ? 'status=10|0' : 'status=all';
    return await requestCounterparty(
      `/assets/${encodeURIComponent(asset)}/dispensers?${statusQuery}&verbose=true`,
      parseDispensers,
    );
  } catch (e) {
    console.error(`Error fetching dispensers for ${asset}:`, e);
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

const assetInfoCache = new Map<string, AssetInfo>();
const divisibilityCache = new Map<string, boolean>();
const assetInfoInFlight = new Map<string, Promise<AssetInfo | null>>();

/**
 * Get asset metadata from Counterparty
 */
export async function getAssetInfo(asset: string): Promise<AssetInfo | null> {
  const normalizedAsset = asset.trim().toUpperCase();
  if (!normalizedAsset) return null;

  const cached = assetInfoCache.get(normalizedAsset);
  if (cached) return cached;

  const pending = assetInfoInFlight.get(normalizedAsset);
  if (pending) return pending;

  const request = (async () => {
    try {
      const info = await requestCounterparty(
        `/assets/${encodeURIComponent(normalizedAsset)}?verbose=true`,
        (result) => parseAssetInfo(result, normalizedAsset),
      );
      assetInfoCache.set(normalizedAsset, info);
      divisibilityCache.set(normalizedAsset, info.divisible);
      return info;
    } catch {
      return null;
    } finally {
      assetInfoInFlight.delete(normalizedAsset);
    }
  })();

  assetInfoInFlight.set(normalizedAsset, request);
  return request;
}

/**
 * Get whether an asset is divisible (cached)
 */
export async function getAssetDivisibility(asset: string): Promise<boolean> {
  const normalizedAsset = asset.trim().toUpperCase();
  if (!normalizedAsset) return true;

  if (DEFAULT_DIVISIBLE_ASSETS.has(normalizedAsset)) {
    divisibilityCache.set(normalizedAsset, true);
    return true;
  }

  const cached = divisibilityCache.get(normalizedAsset);
  if (cached !== undefined) return cached;

  const info = await getAssetInfo(normalizedAsset);
  const divisible = info?.divisible ?? true;
  divisibilityCache.set(normalizedAsset, divisible);
  return divisible;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBaseUnits(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a safe integer or integer string`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  }
  throw new Error(`${label} must be an integer`);
}

function serializeBaseUnits(value: BaseUnitsLike, label: string): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a safe integer`);
    }
    return BigInt(value).toString();
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${label} must be an integer`);
  }
  return trimmed;
}

function asOptionalNumber(value: unknown): number | undefined {
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function parseOrderStatus(value: unknown): Order['status'] {
  if (value === 'open' || value === 'filled' || value === 'cancelled' || value === 'expired') {
    return value;
  }
  return 'open';
}

function parseOrder(value: unknown): Order {
  if (!isJsonObject(value)) {
    throw new Error('Malformed order record');
  }

  const txHash = asString(value.tx_hash).trim();
  const giveAsset = asString(value.give_asset).trim().toUpperCase();
  const getAsset = asString(value.get_asset).trim().toUpperCase();
  if (!txHash || !giveAsset || !getAsset) {
    throw new Error('Malformed order record');
  }

  return {
    tx_hash: txHash,
    source: asString(value.source),
    give_asset: giveAsset,
    give_quantity: asBaseUnits(value.give_quantity, 'give_quantity'),
    give_remaining: asBaseUnits(value.give_remaining, 'give_remaining'),
    get_asset: getAsset,
    get_quantity: asBaseUnits(value.get_quantity, 'get_quantity'),
    get_remaining: asBaseUnits(value.get_remaining, 'get_remaining'),
    expiration: asNumber(value.expiration),
    expire_index: asNumber(value.expire_index),
    status: parseOrderStatus(value.status),
    give_price: asNumber(value.give_price),
    get_price: asNumber(value.get_price),
    block_time: asNumber(value.block_time),
    give_quantity_normalized: asOptionalString(value.give_quantity_normalized),
    get_quantity_normalized: asOptionalString(value.get_quantity_normalized),
    give_remaining_normalized: asOptionalString(value.give_remaining_normalized),
    get_remaining_normalized: asOptionalString(value.get_remaining_normalized),
  };
}

function parseOrders(result: unknown): Order[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((order) => {
      try {
        return parseOrder(order);
      } catch {
        return null;
      }
    })
    .filter((order): order is Order => order !== null);
}

function parseDispenserAsOrder(value: unknown): Order {
  if (!isJsonObject(value)) {
    throw new Error('Malformed dispenser record');
  }

  const txHash = asString(value.tx_hash).trim();
  const giveAsset = asString(value.asset).trim().toUpperCase();
  if (!txHash || !giveAsset) {
    throw new Error('Malformed dispenser record');
  }

  const giveQuantity = asBaseUnits(value.give_quantity, 'give_quantity');
  const satoshirate = asBaseUnits(value.satoshirate, 'satoshirate');
  const escrowQuantity = asBaseUnits(value.escrow_quantity, 'escrow_quantity');
  const dispenseCount = asNumber(value.dispense_count);
  
  const totalGiven = BigInt(dispenseCount) * giveQuantity;
  let remaining = escrowQuantity - totalGiven;
  if (remaining < 0n) remaining = 0n;

  // Dispenser gives Asset, Gets BTC
  const getAsset = 'BTC';
  const getRemaining = remaining === 0n ? 0n : (remaining / giveQuantity) * satoshirate;
  
  // Fallbacks for statuses: 0=open, 10=open
  const rawStatus = asNumber(value.status);
  const status = (rawStatus === 0 || rawStatus === 10) ? 'open' : 'filled';

  return {
    tx_hash: txHash,
    source: asString(value.source),
    give_asset: giveAsset,
    give_quantity: giveQuantity,
    give_remaining: remaining,
    get_asset: getAsset,
    get_quantity: satoshirate,
    get_remaining: getRemaining,
    expiration: 0,
    expire_index: 0,
    status: status,
    give_price: asNumber(value.price),
    get_price: asNumber(value.price),
    block_time: asNumber(value.block_index), // Close enough if time isn't present
    is_dispenser: true,
  };
}

function parseDispensers(result: unknown): Order[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((disp) => {
      try {
        return parseDispenserAsOrder(disp);
      } catch {
        return null;
      }
    })
    .filter((order): order is Order => order !== null);
}

function parseBalance(value: unknown): Balance {
  if (!isJsonObject(value)) {
    throw new Error('Malformed balance record');
  }

  const address = asString(value.address).trim();
  const asset = asString(value.asset).trim().toUpperCase();
  if (!address || !asset) {
    throw new Error('Malformed balance record');
  }

  return {
    address,
    asset,
    quantity: asBaseUnits(value.quantity, 'quantity'),
    quantity_normalized: asOptionalString(value.quantity_normalized),
  };
}

function parseBalances(result: unknown): Balance[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((balance) => {
      try {
        return parseBalance(balance);
      } catch {
        return null;
      }
    })
    .filter((balance): balance is Balance => balance !== null);
}

function parseComposeResult(result: unknown): ComposeResult {
  if (!isJsonObject(result)) {
    throw new Error('Malformed compose response');
  }

  const rawtransaction = asString(result.rawtransaction);
  if (!rawtransaction) {
    throw new Error('Compose response is missing rawtransaction');
  }

  return {
    rawtransaction,
    params: isJsonObject(result.params) ? result.params : {},
    name: asString(result.name),
    psbt: asOptionalString(result.psbt),
  };
}

function parseMempoolEvent(value: unknown): MempoolEvent {
  if (!isJsonObject(value)) {
    throw new Error('Malformed mempool event');
  }

  return {
    tx_hash: asString(value.tx_hash),
    event: asString(value.event),
    params: isJsonObject(value.params) ? value.params : {},
    timestamp: asNumber(value.timestamp),
  };
}

function parseMempoolEvents(result: unknown): MempoolEvent[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((event) => {
      try {
        return parseMempoolEvent(event);
      } catch {
        return null;
      }
    })
    .filter((event): event is MempoolEvent => event !== null);
}

function parseAssetInfo(result: unknown, fallbackAsset: string): AssetInfo {
  const value = Array.isArray(result) ? result[0] : result;
  if (!isJsonObject(value)) {
    throw new Error('Malformed asset metadata');
  }

  return {
    asset: asString(value.asset, fallbackAsset).toUpperCase(),
    divisible: asBoolean(value.divisible, true),
    supply: asOptionalNumber(value.supply),
    description: asOptionalString(value.description),
    issuer: asOptionalString(value.issuer),
    locked: asBoolean(value.locked, false),
  };
}

function parseApiResult(payload: unknown): { result: unknown; error?: string } {
  if (!isJsonObject(payload)) {
    throw new Error('Counterparty API returned an unexpected payload');
  }

  const error = asOptionalString(payload.error);
  return { result: payload.result, error };
}

function extractApiErrorMessage(payload: unknown): string | null {
  if (!isJsonObject(payload)) return null;
  const error = asOptionalString(payload.error);
  if (error) return error;
  const message = asOptionalString(payload.message);
  return message || null;
}

function normalizeTransactionStatus(rawStatus: string, confirmations: number): TransactionStatus {
  const statusText = rawStatus.toLowerCase();
  if (
    statusText.includes('fail') ||
    statusText.includes('invalid') ||
    statusText.includes('reject') ||
    statusText.includes('drop')
  ) {
    return 'failed';
  }
  if (confirmations > 0 || statusText.includes('confirm')) {
    return 'confirmed';
  }
  if (
    statusText.includes('mempool') ||
    statusText.includes('unconfirm') ||
    statusText.includes('pending')
  ) {
    return 'mempool';
  }
  return 'unknown';
}

function parseCounterpartyTransactionState(result: unknown, txid: string): TransactionState {
  if (!isJsonObject(result)) {
    throw new Error('Malformed counterparty transaction response');
  }

  const rawConfirmations = asNumber(result.confirmations, 0);
  const status = normalizeTransactionStatus(asString(result.status), rawConfirmations);
  const confirmations = status === 'confirmed'
    ? Math.max(1, rawConfirmations)
    : Math.max(0, rawConfirmations);
  const blockHeight =
    asOptionalNumber(result.block_height) ??
    asOptionalNumber(result.block_index) ??
    asOptionalNumber(result.block);
  const blockTime =
    asOptionalNumber(result.block_time) ??
    asOptionalNumber(result.blocktime) ??
    asOptionalNumber(result.timestamp);

  return {
    txid,
    status,
    confirmations,
    blockHeight,
    blockTime,
    source: 'counterparty',
  };
}

interface ExplorerStatusPayload {
  confirmed: boolean;
  block_height?: number;
  block_time?: number;
}

function parseExplorerStatus(payload: unknown): ExplorerStatusPayload {
  if (!isJsonObject(payload)) {
    throw new Error('Malformed explorer transaction status response');
  }

  return {
    confirmed: asBoolean(payload.confirmed, false),
    block_height: asOptionalNumber(payload.block_height),
    block_time: asOptionalNumber(payload.block_time),
  };
}

async function fetchTipHeight(url: string): Promise<number | undefined> {
  try {
    const payload = await requestJson(url);
    if (typeof payload === 'number' && Number.isFinite(payload)) {
      return payload;
    }
    if (typeof payload === 'string') {
      const parsed = Number.parseInt(payload, 10);
      if (Number.isFinite(parsed)) return parsed;
      return undefined;
    }
    if (isJsonObject(payload)) {
      return asOptionalNumber(payload.height) ?? asOptionalNumber(payload.tip_height);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function getExplorerTransactionState(
  source: TransactionState['source'],
  statusUrl: string,
  tipHeightUrl: string,
  txid: string,
): Promise<TransactionState> {
  const payload = await requestJson(statusUrl);
  const statusPayload = parseExplorerStatus(payload);

  let confirmations = 0;
  if (statusPayload.confirmed) {
    const tipHeight = await fetchTipHeight(tipHeightUrl);
    if (tipHeight !== undefined && statusPayload.block_height !== undefined) {
      confirmations = Math.max(1, tipHeight - statusPayload.block_height + 1);
    } else {
      confirmations = 1;
    }
  }

  return {
    txid,
    status: statusPayload.confirmed ? 'confirmed' : 'mempool',
    confirmations,
    blockHeight: statusPayload.block_height,
    blockTime: statusPayload.block_time,
    source,
  };
}

function isRetriableError(error: unknown, statusCode?: number): boolean {
  if (statusCode !== undefined && statusCode >= 500) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return false;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestCounterparty<T>(
  path: string,
  parseResult: (result: unknown) => T,
): Promise<T> {
  const endpoint = path.startsWith('http') ? path : `${API_BASE}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let statusCode: number | undefined;

    try {
      const res = await fetch(endpoint, { signal: controller.signal });
      statusCode = res.status;
      const raw = await res.text();
      const payload = raw ? JSON.parse(raw) : {};

      if (!res.ok) {
        const message = extractApiErrorMessage(payload) ?? res.statusText;
        throw new Error(`Counterparty API request failed (${res.status}): ${message}`);
      }

      const { result, error } = parseApiResult(payload);
      if (error) {
        throw new Error(`Counterparty API error: ${error}`);
      }

      return parseResult(result);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const shouldRetry = attempt < MAX_RETRIES && isRetriableError(error, statusCode);
      if (!shouldRetry) break;
      await wait(RETRY_BACKOFF_MS * (attempt + 1));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error('Counterparty request failed');
}

async function requestJson(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let statusCode: number | undefined;

    try {
      const res = await fetch(url, { signal: controller.signal });
      statusCode = res.status;
      const raw = await res.text();
      const payload = raw ? JSON.parse(raw) : {};

      if (!res.ok) {
        throw new Error(`HTTP request failed (${res.status}): ${res.statusText}`);
      }

      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const shouldRetry = attempt < MAX_RETRIES && isRetriableError(error, statusCode);
      if (!shouldRetry) break;
      await wait(RETRY_BACKOFF_MS * (attempt + 1));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error('HTTP request failed');
}
