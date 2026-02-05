import { useState, useMemo } from 'react';
import type { Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface OrderBookProps {
  orders: Order[];
  asset1: string;
  asset2: string;
  loading: boolean;
  error: string | null;
  onOrderClick?: (order: Order, sweepSet: Order[]) => void;
}

export function OrderBook({ orders, asset1, asset2, loading, error, onOrderClick }: OrderBookProps) {
  const [hoveredOrder, setHoveredOrder] = useState<Order | null>(null);

  // Split and Sort orders to make "Sweeping" intuitive
  // Asks (Sellers): We want the CHEAPEST first (Price Ascending)
  // Bids (Buyers): We want the HIGHEST BID first (Price Descending)
  const { asks, bids } = useMemo(() => {
    const askList = orders
      .filter(o => o.give_asset === asset1 && o.status === 'open')
      .sort((a, b) => {
        const priceA = a.get_quantity / a.give_quantity;
        const priceB = b.get_quantity / b.give_quantity;
        return priceA - priceB;
      });

    const bidList = orders
      .filter(o => o.get_asset === asset1 && o.status === 'open')
      .sort((a, b) => {
        const priceA = a.give_quantity / a.get_quantity;
        const priceB = b.give_quantity / b.get_quantity;
        return priceB - priceA; // Descending
      });

    return { asks: askList, bids: bidList };
  }, [orders, asset1]);

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
    let totalGive = 0;
    let totalGet = 0;

    sweepSet.forEach(o => {
      totalGive += o.give_remaining;
      totalGet += o.get_remaining;
    });

    const isAsk = sweepSet[0].give_asset === asset1;
    
    // Avg Price calculation
    // If scanning Asks (Selling Base): Price = Total Get (Quote) / Total Give (Base)
    // If scanning Bids (Buying Base): Price = Total Give (Quote) / Total Get (Base)
    const avgPrice = isAsk 
      ? totalGet / totalGive 
      : totalGive / totalGet;

    return { count, totalGive, totalGet, avgPrice, isAsk };
  }, [sweepSet, asset1]);


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
      ? order.get_quantity / order.give_quantity 
      : order.give_quantity / order.get_quantity;
    
    const amount = isSell ? order.give_remaining : order.get_remaining;
    const tradeAsset = isSell ? order.give_asset : order.get_asset;
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
          {isSell ? 'SELL' : 'BUY'}
        </td>
        <td>
          <span className="order-asset">
             <AssetIcon asset={tradeAsset} size={18} showStampNumber />
          </span>
        </td>
        <td>{price.toFixed(6)}</td>
        <td>{order.give_quantity_normalized || (amount / 100000000).toFixed(4)}</td>
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
            <div>Get: {sweepStats.isAsk ? sweepStats.totalGive.toFixed(4) : sweepStats.totalGet.toFixed(4)} {asset1}</div>
            <div>Pay: {sweepStats.isAsk ? sweepStats.totalGet.toFixed(4) : sweepStats.totalGive.toFixed(4)} {asset2}</div>
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
