import { useState, useEffect, useCallback, useRef } from 'react';
import { getUserOrders, type Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { baseUnitsToNumber } from '../lib/quantity';

type StatusFilter = 'all' | 'open' | 'filled' | 'cancelled' | 'expired';

interface OrderHistoryProps {
  userAddress: string;
  onViewPair?: (asset1: string, asset2: string) => void;
}

const STATUS_LABELS: Record<Order['status'], { label: string; color: string; emoji: string }> = {
  open: { label: 'Open', color: 'var(--success)', emoji: '🟢' },
  filled: { label: 'Filled', color: 'var(--accent-primary)', emoji: '✅' },
  cancelled: { label: 'Cancelled', color: 'var(--text-muted)', emoji: '⛔' },
  expired: { label: 'Expired', color: 'var(--warning)', emoji: '⏰' },
};

function formatDate(blockTime: number): string {
  if (!blockTime || blockTime <= 0) return '—';
  const date = new Date(blockTime * 1000);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function OrderHistory({ userAddress, onViewPair }: OrderHistoryProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const requestId = useRef(0);

  const fetchOrders = useCallback(async () => {
    if (!userAddress) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getUserOrders(userAddress, statusFilter);
      if (id !== requestId.current) return;
      // Sort by block_time descending (newest first)
      const sorted = data.sort((a, b) => (b.block_time || 0) - (a.block_time || 0));
      setOrders(sorted);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load order history');
      setOrders([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userAddress, statusFilter]);

  useEffect(() => {
    if (userAddress) fetchOrders();
  }, [userAddress, statusFilter, fetchOrders]);

  if (!userAddress) return null;

  const statusCounts = orders.reduce(
    (acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const filteredOrders = statusFilter === 'all' ? orders : orders.filter(o => o.status === statusFilter);
  const displayOrders = expanded ? filteredOrders : filteredOrders.slice(0, 5);

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-2">
        <h3 className="flex items-center gap-1" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          <span style={{ fontSize: '1.25rem' }}>📋</span> Order History
          {orders.length > 0 && (
            <span className="text-muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>
              ({orders.length})
            </span>
          )}
        </h3>
        <button className="btn-icon" onClick={fetchOrders} title="Refresh order history">
          ↻
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="order-history-filters">
        {(['all', 'open', 'filled', 'cancelled', 'expired'] as StatusFilter[]).map(status => {
          const count = status === 'all' ? orders.length : (statusCounts[status] || 0);
          const isActive = statusFilter === status;
          return (
            <button
              key={status}
              className={`order-history-filter ${isActive ? 'active' : ''}`}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'all' ? 'All' : STATUS_LABELS[status].label}
              {count > 0 && <span className="order-history-filter-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Loading */}
      {loading && (
        <div className="loading-state" style={{ padding: '1rem' }}>
          <span className="spinner"></span>
          <div className="text-muted" style={{ fontSize: '0.875rem' }}>Loading your orders...</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" onClick={fetchOrders}>Retry</button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && filteredOrders.length === 0 && (
        <div className="empty-state" style={{ padding: '1.5rem 0' }}>
          <div className="empty-state-icon">📭</div>
          <div className="empty-state-title">No Orders Found</div>
          <div className="empty-state-text">
            {statusFilter === 'all'
              ? "You haven't placed any orders yet"
              : `No ${statusFilter} orders found`}
          </div>
        </div>
      )}

      {/* Order list */}
      {!loading && !error && filteredOrders.length > 0 && (
        <>
          <div className="order-history-list">
            {displayOrders.map(order => {
              const statusInfo = STATUS_LABELS[order.status];
              const giveNorm = order.give_quantity_normalized;
              const getNorm = order.get_quantity_normalized;
              const giveDisplay = giveNorm ? giveNorm : baseUnitsToNumber(order.give_quantity, true).toLocaleString(undefined, { maximumFractionDigits: 8 });
              const getDisplay = getNorm ? getNorm : baseUnitsToNumber(order.get_quantity, true).toLocaleString(undefined, { maximumFractionDigits: 8 });

              // Fill percentage for open orders
              const fillPct = order.give_quantity > 0n
                ? Number(((order.give_quantity - order.give_remaining) * 100n) / order.give_quantity)
                : 0;

              return (
                <div
                  key={order.tx_hash}
                  className="order-history-item"
                  onClick={() => onViewPair?.(order.give_asset, order.get_asset)}
                  style={{ cursor: onViewPair ? 'pointer' : 'default' }}
                >
                  <div className="order-history-row-top">
                    <div className="flex items-center gap-1">
                      <span style={{ fontSize: '0.75rem' }}>{statusInfo.emoji}</span>
                      <span className="order-history-status" style={{ color: statusInfo.color }}>
                        {statusInfo.label}
                      </span>
                    </div>
                    <span className="text-muted" style={{ fontSize: '0.625rem' }}>
                      {formatDate(order.block_time)}
                    </span>
                  </div>

                  <div className="order-history-pair">
                    <div className="order-history-side">
                      <span className="text-muted" style={{ fontSize: '0.625rem' }}>Give</span>
                      <div className="flex items-center gap-1">
                        <AssetIcon asset={order.give_asset} size={14} />
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem' }}>
                          {giveDisplay}
                        </span>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{order.give_asset}</span>
                      </div>
                    </div>
                    <span className="order-history-arrow">→</span>
                    <div className="order-history-side">
                      <span className="text-muted" style={{ fontSize: '0.625rem' }}>Get</span>
                      <div className="flex items-center gap-1">
                        <AssetIcon asset={order.get_asset} size={14} />
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem' }}>
                          {getDisplay}
                        </span>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{order.get_asset}</span>
                      </div>
                    </div>
                  </div>

                  {/* Fill bar for open orders */}
                  {order.status === 'open' && (
                    <div className="order-history-fill">
                      <div className="order-history-fill-bar" style={{ width: `${fillPct}%` }}></div>
                      <span className="order-history-fill-text">{fillPct}% filled</span>
                    </div>
                  )}

                  <div className="text-muted truncate" style={{ fontSize: '0.575rem', marginTop: '0.25rem' }}>
                    {order.tx_hash}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Show more / less */}
          {filteredOrders.length > 5 && (
            <button
              className="btn-secondary order-history-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? `Show less` : `Show all ${filteredOrders.length} orders`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
