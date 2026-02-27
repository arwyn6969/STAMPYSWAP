import { useState, useMemo, useEffect, useCallback } from 'react';
import { getAssetDivisibility, type Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { calculatePrice, formatBaseUnits } from '../lib/quantity';

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

  // Split and Sort orders to make "Sweeping" intuitive
  // Asks (Sellers): We want the CHEAPEST first (Price Ascending)
  // Bids (Buyers): We want the HIGHEST BID first (Price Descending)
  const { asks, bids } = useMemo(() => {
    const askList = orders
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

    const bidList = orders
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
        return priceB - priceA; // Descending
      });

    return { asks: askList, bids: bidList };
  }, [orders, asset1, isDivisible]);

  // Calculate the "Sweep Set" (The orders that would be filled)
  const sweepSet = useMemo(() => {
    if (!hoveredOrder) return [];
    
    const isAsk = hoveredOrder.give_asset === asset1;
    const list = isAsk ? asks : bids;
    const index = list.indexOf(hoveredOrder);
    
    if (index === -1) return [];
    
    // In a sorted list (Best -> Worst), a sweep takes everything up to the target
    return list.slice(0, index + 1);
  }, [hoveredOrder, asks, bids, asset1]);

  // Calculate stats for the tooltip
  const sweepStats = useMemo(() => {
    if (sweepSet.length === 0) return null;
    
    const count = sweepSet.length;
    let totalGive = 0n;
    let totalGet = 0n;

    sweepSet.forEach(o => {
      totalGive += o.give_remaining;
      totalGet += o.get_remaining;
    });

    const isAsk = sweepSet[0].give_asset === asset1;
    const avgPrice = isAsk
      ? calculatePrice(totalGet, isDivisible(asset2), totalGive, isDivisible(asset1))
      : calculatePrice(totalGive, isDivisible(asset2), totalGet, isDivisible(asset1));
    const getDisplay = isAsk
      ? formatBaseUnits(totalGive, isDivisible(asset1))
      : formatBaseUnits(totalGet, isDivisible(asset1));
    const payDisplay = isAsk
      ? formatBaseUnits(totalGet, isDivisible(asset2))
      : formatBaseUnits(totalGive, isDivisible(asset2));

    return { count, avgPrice, isAsk, getDisplay, payDisplay };
  }, [sweepSet, asset1, asset2, isDivisible]);


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
    const price = isSell
      ? calculatePrice(order.get_quantity, isDivisible(order.get_asset), order.give_quantity, isDivisible(order.give_asset))
      : calculatePrice(order.give_quantity, isDivisible(order.give_asset), order.get_quantity, isDivisible(order.get_asset));
    
    const amount = isSell ? order.give_remaining : order.get_remaining;
    const tradeAsset = isSell ? order.give_asset : order.get_asset;
    const displayAmount = formatBaseUnits(amount, isDivisible(tradeAsset));
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
        onClick={() => onOrderClick?.(order, sweepSet)}
      >
        <td className={isSell ? 'text-error' : 'text-success'}>
          {isSell ? (order.is_dispenser ? 'DISPENSE' : 'SELL') : 'BUY'}
        </td>
        <td>
          <span className="order-asset">
             <AssetIcon asset={tradeAsset} size={18} showStampNumber />
          </span>
        </td>
        <td>{price.toFixed(6)}</td>
        <td>
          <div className="flex justify-between items-center">
            <span>{displayAmount}</span>
            {onOrderCompete && (
              <button
                className="btn-secondary"
                style={{ 
                  padding: '0.125rem 0.375rem', 
                  fontSize: '0.625rem', 
                  opacity: isHovered ? 1 : 0.3, 
                  transition: 'opacity 0.2s',
                  marginLeft: '0.5rem'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOrderCompete(order);
                }}
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

  return (
    <div className="card relative">
      <div className="flex justify-between items-center mb-2">
        <h2>Order Book</h2>
        <span className="badge pair-badge">
          <AssetIcon asset={asset1} size={16} />
          <span>{asset1}</span>
          <span className="pair-separator">/</span>
          <AssetIcon asset={asset2} size={16} />
          <span>{asset2}</span>
        </span>
      </div>

       {/* Sweep Tooltip - Floats absolute or fixed when sweeping */}
       {hoveredOrder && sweepStats && (
        <div className="absolute top-12 left-0 right-0 z-10 mx-4 p-3 rounded shadow-lg bg-base-100 border border-base-content/20 text-sm animate-fade-in pointer-events-none" style={{ background: '#1a1a1a', border: '1px solid #333' }}>
          <div className="flex justify-between items-center mb-1">
            <span className="font-bold">
              {sweepStats.isAsk ? `Buy ${sweepStats.count} Orders` : `Sell into ${sweepStats.count} Bids`}
            </span>
            <span className="badge badge-primary">Avg Price: {sweepStats.avgPrice.toFixed(6)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs opacity-80">
            <div>Get: {sweepStats.getDisplay} {asset1}</div>
            <div>Pay: {sweepStats.payDisplay} {asset2}</div>
          </div>
          <div className="mt-1 text-center text-[10px] uppercase tracking-wide opacity-60">
            Click to Auto-Fill
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
              <table className="order-table">
                <tbody>
                  {asks.slice(0, 10).map(o => renderRow(o, true))}
                </tbody>
              </table>
            </div>
          )}
          
          {/* Bids (Buyers) - Showing "Highest Bid" first */}
          {bids.length > 0 && (
            <div className="order-section">
              <div className="text-xs uppercase font-bold text-muted mb-1 px-2">Buying {asset1}</div>
               <table className="order-table">
                <tbody>
                  {bids.slice(0, 10).map(o => renderRow(o, false))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
