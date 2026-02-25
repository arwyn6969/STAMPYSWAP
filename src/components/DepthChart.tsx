import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAssetDivisibility, type Order } from '../lib/counterparty';
import { baseUnitsToNumber, calculatePrice } from '../lib/quantity';

interface DepthChartProps {
  orders: Order[];
  asset1: string;
  asset2: string;
}

export function DepthChart({ orders, asset1, asset2 }: DepthChartProps) {
  const [divisibility, setDivisibility] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const assets = [asset1, asset2].filter(Boolean);
    const uniqueAssets = Array.from(new Set(assets));
    if (uniqueAssets.length === 0) return undefined;

    const load = async () => {
      const entries = await Promise.all(
        uniqueAssets.map(async (asset) => [asset, await getAssetDivisibility(asset)] as const),
      );
      if (cancelled) return;
      setDivisibility((prev) => {
        const next = { ...prev };
        for (const [asset, divisible] of entries) {
          next[asset] = divisible;
        }
        return next;
      });
    };

    load().catch(() => {
      // Fall back to default divisibility assumptions.
    });

    return () => {
      cancelled = true;
    };
  }, [asset1, asset2]);

  const isDivisible = useCallback(
    (asset: string) => divisibility[asset] ?? true,
    [divisibility],
  );

  const { buyOrders, sellOrders, maxDepth, midPrice, spread } = useMemo(() => {
    const buys: { price: number; cumulative: number }[] = [];
    const sells: { price: number; cumulative: number }[] = [];

    // Separate and sort orders
    const buyList = orders
      .filter(o => o.get_asset === asset1 && o.status === 'open')
      .sort((a, b) => {
        const priceA = calculatePrice(
          a.give_quantity,
          isDivisible(a.give_asset),
          a.get_quantity,
          isDivisible(a.get_asset),
        );
        const priceB = calculatePrice(
          b.give_quantity,
          isDivisible(b.give_asset),
          b.get_quantity,
          isDivisible(b.get_asset),
        );
        return priceB - priceA;
      });
    
    const sellList = orders
      .filter(o => o.give_asset === asset1 && o.status === 'open')
      .sort((a, b) => {
        const priceA = calculatePrice(
          a.get_quantity,
          isDivisible(a.get_asset),
          a.give_quantity,
          isDivisible(a.give_asset),
        );
        const priceB = calculatePrice(
          b.get_quantity,
          isDivisible(b.get_asset),
          b.give_quantity,
          isDivisible(b.give_asset),
        );
        return priceA - priceB;
      });

    // Build cumulative depth for buys
    let cumBuy = 0;
    buyList.forEach(o => {
      const price = calculatePrice(
        o.give_quantity,
        isDivisible(o.give_asset),
        o.get_quantity,
        isDivisible(o.get_asset),
      );
      cumBuy += baseUnitsToNumber(o.get_remaining, isDivisible(asset1));
      buys.push({ price, cumulative: cumBuy });
    });

    // Build cumulative depth for sells
    let cumSell = 0;
    sellList.forEach(o => {
      const price = calculatePrice(
        o.get_quantity,
        isDivisible(o.get_asset),
        o.give_quantity,
        isDivisible(o.give_asset),
      );
      cumSell += baseUnitsToNumber(o.give_remaining, isDivisible(asset1));
      sells.push({ price, cumulative: cumSell });
    });

    const maxDepth = Math.max(
      buys[buys.length - 1]?.cumulative || 0,
      sells[sells.length - 1]?.cumulative || 0,
      1
    );

    const bestBid = buys[0]?.price || 0;
    const bestAsk = sells[0]?.price || 0;
    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid && bestAsk ? ((bestAsk - bestBid) / midPrice * 100) : 0;

    return { 
      buyOrders: buys, 
      sellOrders: sells, 
      maxDepth,
      midPrice,
      spread
    };
  }, [orders, asset1, isDivisible]);

  if (orders.length === 0) {
    return (
      <div className="depth-chart-empty">
        <p className="text-muted">No order data available</p>
      </div>
    );
  }

  return (
    <div className="depth-chart">
      {/* Price ticker */}
      <div className="depth-header">
        <div className="price-ticker">
          <span className="price-label">Mid Price</span>
          <span className="price-value">{midPrice.toFixed(8)}</span>
          <span className="price-unit">{asset2}</span>
        </div>
        <div className="spread-indicator">
          <span className="spread-label">Spread</span>
          <span className="spread-value">{spread.toFixed(2)}%</span>
        </div>
      </div>

      {/* Visual depth bars */}
      <div className="depth-visual">
        <div className="depth-side depth-buy">
          <div className="depth-label">BIDS</div>
          {buyOrders.slice(0, 8).map((order, i) => (
            <div key={i} className="depth-bar-container">
              <div 
                className="depth-bar depth-bar-buy"
                style={{ width: `${(order.cumulative / maxDepth) * 100}%` }}
              />
              <span className="depth-price">{order.price.toFixed(4)}</span>
            </div>
          ))}
        </div>

        <div className="depth-side depth-sell">
          <div className="depth-label">ASKS</div>
          {sellOrders.slice(0, 8).map((order, i) => (
            <div key={i} className="depth-bar-container">
              <div 
                className="depth-bar depth-bar-sell"
                style={{ width: `${(order.cumulative / maxDepth) * 100}%` }}
              />
              <span className="depth-price">{order.price.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      <div className="depth-stats">
        <div className="stat">
          <span className="stat-label">Total Bids</span>
          <span className="stat-value text-success">{buyOrders.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Total Asks</span>
          <span className="stat-value text-error">{sellOrders.length}</span>
        </div>
      </div>
    </div>
  );
}
