import { useState, useEffect, useCallback, useRef } from 'react';
import { getAssetDivisibility, getUserOrders, type Order } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { formatBaseUnits } from '../lib/quantity';
import {
  filterOrdersByStatus,
  getOrderStatusCounts,
  type OrderStatusFilter,
  sortOrdersByNewest,
} from '../lib/orderHistory';

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
  const [statusFilter, setStatusFilter] = useState<OrderStatusFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const [divisibility, setDivisibility] = useState<Record<string, boolean>>({});
  const requestId = useRef(0);

  const fetchOrders = useCallback(async (force = false) => {
    if (!userAddress) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getUserOrders(userAddress, 'all', { force });
      if (id !== requestId.current) return;
      setOrders(sortOrdersByNewest(data));
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load order history');
      setOrders([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userAddress]);

  useEffect(() => {
    if (userAddress) fetchOrders();
  }, [userAddress, fetchOrders]);

  useEffect(() => {
    setExpanded(false);
  }, [statusFilter]);
  const filteredOrders = filterOrdersByStatus(orders, statusFilter);
  const displayOrders = expanded ? filteredOrders : filteredOrders.slice(0, 5);
  const statusCounts = getOrderStatusCounts(orders);

  useEffect(() => {
    let cancelled = false;
    const assets = Array.from(new Set(displayOrders.flatMap((order) => [order.give_asset, order.get_asset])));
    const unresolvedAssets = assets.filter((asset) => divisibility[asset] === undefined);
    if (unresolvedAssets.length === 0) return undefined;

    const load = async () => {
      const entries = await Promise.all(
        unresolvedAssets.map(async (asset) => [asset, await getAssetDivisibility(asset)] as const),
      );
      if (cancelled) return;
      setDivisibility((prev) => {
        const next = { ...prev };
        for (const [asset, isDivisible] of entries) {
          next[asset] = isDivisible;
        }
        return next;
      });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [displayOrders, divisibility]);

  if (!userAddress) return null;

  return (
    <div className="card utility-card utility-card-history">
      <div className="utility-card-header">
        <div>
          <h3 className="utility-card-title">Order History</h3>
          <p className="utility-card-subtitle">
            Filter recent orders by lifecycle and jump back into any traded market.
          </p>
        </div>
        <div className="utility-card-header-actions">
          {orders.length > 0 && (
            <span className="utility-card-count">
              {orders.length} total
            </span>
          )}
          <button className="btn-icon" type="button" onClick={() => void fetchOrders(true)} title="Refresh order history">
            ↻
          </button>
        </div>
      </div>

      <div className="order-history-summary">
        <div className="order-history-summary-item">
          <span className="order-history-summary-label">Open</span>
          <span className="order-history-summary-value">{statusCounts.open}</span>
        </div>
        <div className="order-history-summary-item">
          <span className="order-history-summary-label">Filled</span>
          <span className="order-history-summary-value">{statusCounts.filled}</span>
        </div>
        <div className="order-history-summary-item">
          <span className="order-history-summary-label">Closed</span>
          <span className="order-history-summary-value">{statusCounts.cancelled + statusCounts.expired}</span>
        </div>
      </div>

      <div className="order-history-filters">
        {(['all', 'open', 'filled', 'cancelled', 'expired'] as OrderStatusFilter[]).map(status => {
          const count = status === 'all' ? orders.length : (statusCounts[status] || 0);
          const isActive = statusFilter === status;
          return (
            <button
              key={status}
              type="button"
              className={`order-history-filter ${isActive ? 'active' : ''}`}
              aria-pressed={isActive}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'all' ? 'All' : STATUS_LABELS[status].label}
              {count > 0 && <span className="order-history-filter-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {loading && (
        <div className="loading-state utility-loading-state">
          <span className="spinner"></span>
          <div className="text-muted utility-loading-copy">Loading your orders...</div>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" type="button" onClick={() => void fetchOrders(true)}>Retry</button>
        </div>
      )}

      {!loading && !error && filteredOrders.length === 0 && (
        <div className="empty-state utility-empty-state">
          <div className="empty-state-icon">📭</div>
          <div className="empty-state-title">No Orders Found</div>
          <div className="empty-state-text">
            {statusFilter === 'all'
              ? "You haven't placed any orders yet"
              : `No ${statusFilter} orders found`}
          </div>
        </div>
      )}

      {!loading && !error && filteredOrders.length > 0 && (
        <>
          <div className="order-history-list">
            {displayOrders.map(order => {
              const statusInfo = STATUS_LABELS[order.status];
              const giveNorm = order.give_quantity_normalized;
              const getNorm = order.get_quantity_normalized;
              const giveDisplay = giveNorm
                ? giveNorm
                : formatBaseUnits(order.give_quantity, divisibility[order.give_asset] ?? true);
              const getDisplay = getNorm
                ? getNorm
                : formatBaseUnits(order.get_quantity, divisibility[order.get_asset] ?? true);

              const fillPct = order.give_quantity > 0n
                ? Number(((order.give_quantity - order.give_remaining) * 100n) / order.give_quantity)
                : 0;

              return (
                <button
                  key={order.tx_hash}
                  type="button"
                  className={`order-history-item ${onViewPair ? 'is-clickable' : ''}`}
                  onClick={() => onViewPair?.(order.give_asset, order.get_asset)}
                >
                  <div className="order-history-row-top">
                    <div className="flex items-center gap-1">
                      <span className="order-history-status-emoji">{statusInfo.emoji}</span>
                      <span className="order-history-status" style={{ color: statusInfo.color }}>
                        {statusInfo.label}
                      </span>
                    </div>
                    <span className="order-history-date text-muted">
                      {formatDate(order.block_time)}
                    </span>
                  </div>

                  <div className="order-history-pair">
                    <div className="order-history-side">
                      <span className="order-history-side-label text-muted">Give</span>
                      <div className="flex items-center gap-1">
                        <AssetIcon asset={order.give_asset} size={14} />
                        <span className="order-history-amount">{giveDisplay}</span>
                        <span className="order-history-asset">{order.give_asset}</span>
                      </div>
                    </div>
                    <span className="order-history-arrow">→</span>
                    <div className="order-history-side">
                      <span className="order-history-side-label text-muted">Get</span>
                      <div className="flex items-center gap-1">
                        <AssetIcon asset={order.get_asset} size={14} />
                        <span className="order-history-amount">{getDisplay}</span>
                        <span className="order-history-asset">{order.get_asset}</span>
                      </div>
                    </div>
                  </div>

                  {order.status === 'open' && (
                    <div className="order-history-fill">
                      <div className="order-history-fill-bar" style={{ width: `${fillPct}%` }}></div>
                      <span className="order-history-fill-text">{fillPct}% filled</span>
                    </div>
                  )}

                  <div className="order-history-foot">
                    <span className="text-muted truncate">{order.tx_hash}</span>
                    {onViewPair && <span className="order-history-cta">Open market</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {filteredOrders.length > 5 && (
            <button
              type="button"
              className="btn-secondary order-history-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : `Show all ${filteredOrders.length} orders`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
