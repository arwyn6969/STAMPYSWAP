import { useMemo } from 'react';
import type { Order } from '../lib/counterparty';

interface DepthChartProps {
  orders: Order[];
  asset1: string;
  asset2: string;
}

export function DepthChart({ orders, asset1, asset2 }: DepthChartProps) {
  const { buyOrders, sellOrders, maxDepth, midPrice, spread } = useMemo(() => {
    const buys: { price: number; cumulative: number }[] = [];
    const sells: { price: number; cumulative: number }[] = [];

    // Separate and sort orders
    const buyList = orders
      .filter(o => o.get_asset === asset1 && o.status === 'open')
      .sort((a, b) => b.give_quantity / b.get_quantity - a.give_quantity / a.get_quantity);
    
    const sellList = orders
      .filter(o => o.give_asset === asset1 && o.status === 'open')
      .sort((a, b) => a.get_quantity / a.give_quantity - b.get_quantity / b.give_quantity);

    // Build cumulative depth for buys
    let cumBuy = 0;
    buyList.forEach(o => {
      const price = o.give_quantity / o.get_quantity;
      cumBuy += o.get_remaining;
      buys.push({ price, cumulative: cumBuy });
    });

    // Build cumulative depth for sells
    let cumSell = 0;
    sellList.forEach(o => {
      const price = o.get_quantity / o.give_quantity;
      cumSell += o.give_remaining;
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
  }, [orders, asset1]);

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
