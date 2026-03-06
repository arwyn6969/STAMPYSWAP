import { useState, useMemo, useEffect, useCallback } from 'react';
import { getAssetDivisibility, type Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { formatBaseUnits } from '../lib/quantity';
import {
  buildSweepSetForOrder,
  buildSweepStats,
  getMarketSnapshot,
  getOrderPrice,
  splitOrders,
} from '../lib/orderBook';

interface OrderBookProps {
  orders: Order[];
  asset1: string;
  asset2: string;
  loading: boolean;
  error: string | null;
  onOrderClick?: (order: Order, sweepSet: Order[]) => void;
  onOrderCompete?: (order: Order) => void;
}

export function OrderBook({ orders, asset1, asset2, loading, error, onOrderClick, onOrderCompete }: OrderBookProps) {
  const [hoveredOrder, setHoveredOrder] = useState<Order | null>(null);
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

  const { asks, bids } = useMemo(() => {
    return splitOrders(orders, asset1, isDivisible);
  }, [orders, asset1, isDivisible]);

  const sweepSet = useMemo(() => {
    if (!hoveredOrder) return [];
    return buildSweepSetForOrder(hoveredOrder, asks, bids, asset1);
  }, [hoveredOrder, asks, bids, asset1]);

  const sweepStats = useMemo(() => {
    return buildSweepStats(sweepSet, asset1, asset2, isDivisible);
  }, [sweepSet, asset1, asset2, isDivisible]);

  const marketSnapshot = useMemo(() => getMarketSnapshot(asks, bids, isDivisible), [asks, bids, isDivisible]);
  const bestAsk = asks[0];
  const bestBid = bids[0];

  if (!asset1 || !asset2) {
    return (
      <div className="card">
        <h2>Order Book</h2>
        <div className="empty-state">
          <div className="empty-state-text">Select a trading pair to view orders</div>
        </div>
      </div>
    );
  }

  const renderRow = (order: Order, isSell: boolean) => {
    const price = getOrderPrice(order, isSell, isDivisible);
    const amount = isSell ? order.give_remaining : order.get_remaining;
    const tradeAsset = isSell ? order.give_asset : order.get_asset;
    const displayAmount = formatBaseUnits(amount, isDivisible(tradeAsset));
    const orderSweepSet = buildSweepSetForOrder(order, asks, bids, asset1);
    const isHovered = sweepSet.includes(order);
    const isTarget = hoveredOrder === order;

    return (
      <tr 
        key={order.tx_hash}
        className={`
          cursor-pointer transition-colors
          ${isHovered ? (isSell ? 'bg-error-light' : 'bg-success-light') : ''}
          ${isTarget ? 'font-bold' : ''}
        `}
        onMouseEnter={() => setHoveredOrder(order)}
        onMouseLeave={() => setHoveredOrder(null)}
      >
        <td className={isSell ? 'text-error' : 'text-success'}>
          {isSell ? (order.is_dispenser ? 'DISPENSE' : 'SELL') : 'BUY'}
        </td>
        <td>
          <span className="order-asset">
            <AssetIcon asset={tradeAsset} size={18} showStampNumber />
            <span>{tradeAsset}</span>
          </span>
        </td>
        <td>{price.toFixed(6)}</td>
        <td>
          <span>{displayAmount}</span>
        </td>
        <td>
          <div className="order-row-actions">
            <button
              className="btn-secondary order-action-btn"
              type="button"
              onFocus={() => setHoveredOrder(order)}
              onBlur={() => setHoveredOrder(null)}
              onClick={() => onOrderClick?.(order, [order])}
              title="Use this single order as the draft"
            >
              Fill
            </button>
            <button
              className="btn-secondary order-action-btn"
              type="button"
              onFocus={() => setHoveredOrder(order)}
              onBlur={() => setHoveredOrder(null)}
              onClick={() => onOrderClick?.(order, orderSweepSet)}
              title="Sweep all orders up to this price level"
            >
              {orderSweepSet.length > 1 ? `Sweep ${orderSweepSet.length}` : 'Sweep'}
            </button>
            {onOrderCompete && (
              <button
                className="btn-secondary order-action-btn"
                type="button"
                onClick={() => onOrderCompete(order)}
                title="Copy order parameters to compete"
              >
                Copy
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderMobileCard = (order: Order, isSell: boolean) => {
    const price = getOrderPrice(order, isSell, isDivisible);
    const amount = isSell ? order.give_remaining : order.get_remaining;
    const tradeAsset = isSell ? order.give_asset : order.get_asset;
    const displayAmount = formatBaseUnits(amount, isDivisible(tradeAsset));
    const orderSweepSet = buildSweepSetForOrder(order, asks, bids, asset1);

    return (
      <div key={`${order.tx_hash}-mobile`} className={`order-mobile-card ${isSell ? 'is-ask' : 'is-bid'}`}>
        <div className="order-mobile-card-top">
          <div className="order-mobile-asset">
            <span className={`badge ${isSell ? 'order-mobile-badge-ask' : 'badge-success'}`}>
              {isSell ? (order.is_dispenser ? 'DISPENSE' : 'SELL') : 'BUY'}
            </span>
            <AssetIcon asset={tradeAsset} size={16} showStampNumber />
            <span className="order-mobile-asset-name">{tradeAsset}</span>
          </div>
          <span className="order-mobile-price">{price.toFixed(6)}</span>
        </div>
        <div className="order-mobile-stats">
          <div className="order-mobile-stat">
            <span className="order-mobile-stat-label">Amount</span>
            <span className="order-mobile-stat-value">{displayAmount}</span>
          </div>
          <div className="order-mobile-stat">
            <span className="order-mobile-stat-label">Depth</span>
            <span className="order-mobile-stat-value">
              {orderSweepSet.length > 1 ? `${orderSweepSet.length} levels` : 'Single level'}
            </span>
          </div>
        </div>
        <div className="order-row-actions order-row-actions-mobile">
          <button
            className="btn-secondary order-action-btn"
            type="button"
            onClick={() => onOrderClick?.(order, [order])}
          >
            Fill
          </button>
          <button
            className="btn-secondary order-action-btn"
            type="button"
            onClick={() => onOrderClick?.(order, orderSweepSet)}
          >
            {orderSweepSet.length > 1 ? `Sweep ${orderSweepSet.length}` : 'Sweep'}
          </button>
          {onOrderCompete && (
            <button
              className="btn-secondary order-action-btn"
              type="button"
              onClick={() => onOrderCompete(order)}
            >
              Copy
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="card relative">
      <div className="workspace-card-header">
        <div>
          <h2 className="mb-1">Order Book</h2>
          <p className="workspace-card-subtitle">Use Fill for a single level, Sweep to aggregate depth, or Copy to compete on price.</p>
        </div>
        <div className="order-book-header-meta">
          <span className="badge pair-badge">
            <AssetIcon asset={asset1} size={16} />
            <span>{asset1}</span>
            <span className="pair-separator">/</span>
            <AssetIcon asset={asset2} size={16} />
            <span>{asset2}</span>
          </span>
          <span className="badge">
            Spread {marketSnapshot.spread.toFixed(2)}%
          </span>
        </div>
      </div>

      {onOrderClick && (bestAsk || bestBid) && (
        <div className="order-book-quick-actions">
          {bestAsk && (
            <button
              type="button"
              className="order-book-quick-action"
              onClick={() => onOrderClick?.(bestAsk, [bestAsk])}
            >
              <span className="order-book-quick-kicker">Best ask</span>
              <strong>Buy {asset1}</strong>
              <span>{getOrderPrice(bestAsk, true, isDivisible).toFixed(6)} {asset2}</span>
            </button>
          )}
          {bestBid && (
            <button
              type="button"
              className="order-book-quick-action"
              onClick={() => onOrderClick?.(bestBid, [bestBid])}
            >
              <span className="order-book-quick-kicker">Best bid</span>
              <strong>Sell {asset1}</strong>
              <span>{getOrderPrice(bestBid, false, isDivisible).toFixed(6)} {asset2}</span>
            </button>
          )}
        </div>
      )}

      {hoveredOrder && sweepStats && (
        <div className="absolute top-12 left-0 right-0 z-10 mx-4 p-3 rounded shadow-lg bg-base-100 border border-base-content/20 text-sm animate-fade-in pointer-events-none order-preview-banner">
          <div className="flex justify-between items-center mb-1">
            <span className="font-bold">
              {sweepStats.isAsk ? `Sweep ${sweepStats.count} asks` : `Sweep ${sweepStats.count} bids`}
            </span>
            <span className="badge badge-primary">Avg Price: {sweepStats.avgPrice.toFixed(6)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs opacity-80">
            <div>Get: {sweepStats.getDisplay} {asset1}</div>
            <div>Pay: {sweepStats.payDisplay} {asset2}</div>
          </div>
          <div className="mt-1 text-center text-[10px] uppercase tracking-wide opacity-60">
            Use the Fill or Sweep buttons
          </div>
        </div>
      )}

      {loading && (
        <div className="loading-state">
          <span className="spinner"></span>
          <span className="text-muted">Loading...</span>
        </div>
      )}
      
      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
        </div>
      )}

      {!loading && !error && orders.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <div className="empty-state-title">No Orders Yet</div>
          <div className="empty-state-text">
            Create the first order for this pair!
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="flex flex-col gap-4">
          {/* Asks (Sellers) - Showing "Cheapest" first */}
          {asks.length > 0 && (
            <div className="order-section">
              <div className="text-xs uppercase font-bold text-muted mb-1 px-2">Selling {asset1}</div>
              <div className="order-table-shell">
                <table className="order-table order-book-table-view">
                  <thead>
                    <tr>
                      <th>Side</th>
                      <th>Asset</th>
                      <th>Price</th>
                      <th>Amount</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asks.slice(0, 10).map(o => renderRow(o, true))}
                  </tbody>
                </table>
              </div>
              <div className="order-book-mobile-list">
                {asks.slice(0, 10).map((order) => renderMobileCard(order, true))}
              </div>
            </div>
          )}
          
          {/* Bids (Buyers) - Showing "Highest Bid" first */}
          {bids.length > 0 && (
            <div className="order-section">
              <div className="text-xs uppercase font-bold text-muted mb-1 px-2">Buying {asset1}</div>
              <div className="order-table-shell">
                <table className="order-table order-book-table-view">
                  <thead>
                    <tr>
                      <th>Side</th>
                      <th>Asset</th>
                      <th>Price</th>
                      <th>Amount</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bids.slice(0, 10).map(o => renderRow(o, false))}
                  </tbody>
                </table>
              </div>
              <div className="order-book-mobile-list">
                {bids.slice(0, 10).map((order) => renderMobileCard(order, false))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
