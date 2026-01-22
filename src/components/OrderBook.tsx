import type { Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface OrderBookProps {
  orders: Order[];
  asset1: string;
  asset2: string;
  loading: boolean;
  error: string | null;
}

export function OrderBook({ orders, asset1, asset2, loading, error }: OrderBookProps) {
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

  return (
    <div className="card">
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

      {!loading && !error && orders.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="order-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Asset</th>
                <th>Price</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 15).map((order) => {
                const isSell = order.give_asset === asset1;
                const price = isSell 
                  ? order.get_quantity / order.give_quantity 
                  : order.give_quantity / order.get_quantity;
                const amount = isSell ? order.give_remaining : order.get_remaining;
                const tradeAsset = isSell ? order.give_asset : order.get_asset;

                return (
                  <tr key={order.tx_hash}>
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
                    <td>
                      <span className="badge">{order.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {orders.length > 15 && (
            <p className="text-muted text-center" style={{ padding: '0.5rem', fontSize: '0.75rem' }}>
              Showing 15 of {orders.length} orders
            </p>
          )}
        </div>
      )}
    </div>
  );
}
