import { type Order } from './counterparty.js';
import { calculatePrice, formatBaseUnits } from './quantity.js';

export interface SweepStats {
  count: number;
  avgPrice: number;
  isAsk: boolean;
  getDisplay: string;
  payDisplay: string;
}

export interface MarketSnapshot {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  askCount: number;
  bidCount: number;
}

export function getOrderPrice(
  order: Order,
  isSell: boolean,
  isDivisible: (asset: string) => boolean,
): number {
  if (isSell) {
    return calculatePrice(
      order.get_quantity,
      isDivisible(order.get_asset),
      order.give_quantity,
      isDivisible(order.give_asset),
    );
  }

  return calculatePrice(
    order.give_quantity,
    isDivisible(order.give_asset),
    order.get_quantity,
    isDivisible(order.get_asset),
  );
}

export function splitOrders(
  orders: Order[],
  asset1: string,
  isDivisible: (asset: string) => boolean,
): { asks: Order[]; bids: Order[] } {
  const asks = orders
    .filter((order) => order.give_asset === asset1 && order.status === 'open')
    .sort((left, right) => getOrderPrice(left, true, isDivisible) - getOrderPrice(right, true, isDivisible));

  const bids = orders
    .filter((order) => order.get_asset === asset1 && order.status === 'open')
    .sort((left, right) => getOrderPrice(right, false, isDivisible) - getOrderPrice(left, false, isDivisible));

  return { asks, bids };
}

export function buildSweepSetForOrder(
  targetOrder: Order,
  asks: Order[],
  bids: Order[],
  asset1: string,
): Order[] {
  const isAsk = targetOrder.give_asset === asset1;
  const list = isAsk ? asks : bids;
  const index = list.indexOf(targetOrder);
  if (index === -1) return [targetOrder];
  return list.slice(0, index + 1);
}

export function buildSweepStats(
  sweepSet: Order[],
  asset1: string,
  asset2: string,
  isDivisible: (asset: string) => boolean,
): SweepStats | null {
  if (sweepSet.length === 0) return null;

  let totalGive = 0n;
  let totalGet = 0n;
  for (const order of sweepSet) {
    totalGive += order.give_remaining;
    totalGet += order.get_remaining;
  }

  const isAsk = sweepSet[0].give_asset === asset1;
  const avgPrice = isAsk
    ? calculatePrice(totalGet, isDivisible(asset2), totalGive, isDivisible(asset1))
    : calculatePrice(totalGive, isDivisible(asset2), totalGet, isDivisible(asset1));

  return {
    count: sweepSet.length,
    avgPrice,
    isAsk,
    getDisplay: isAsk
      ? formatBaseUnits(totalGive, isDivisible(asset1))
      : formatBaseUnits(totalGet, isDivisible(asset1)),
    payDisplay: isAsk
      ? formatBaseUnits(totalGet, isDivisible(asset2))
      : formatBaseUnits(totalGive, isDivisible(asset2)),
  };
}

export function getMarketSnapshot(
  asks: Order[],
  bids: Order[],
  isDivisible: (asset: string) => boolean,
): MarketSnapshot {
  const bestAsk = asks[0] ? getOrderPrice(asks[0], true, isDivisible) : 0;
  const bestBid = bids[0] ? getOrderPrice(bids[0], false, isDivisible) : 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spread = bestBid && bestAsk && midPrice > 0
    ? ((bestAsk - bestBid) / midPrice) * 100
    : 0;

  return {
    bestBid,
    bestAsk,
    midPrice,
    spread,
    askCount: asks.length,
    bidCount: bids.length,
  };
}
