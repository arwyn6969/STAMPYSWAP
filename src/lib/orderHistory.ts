import { type Order } from './counterparty.js';

export type OrderStatusFilter = 'all' | 'open' | 'filled' | 'cancelled' | 'expired';

export function sortOrdersByNewest(orders: Order[]): Order[] {
  return [...orders].sort((left, right) => (right.block_time || 0) - (left.block_time || 0));
}

export function getOrderStatusCounts(orders: Order[]): Record<Order['status'], number> {
  return orders.reduce(
    (counts, order) => {
      counts[order.status] += 1;
      return counts;
    },
    {
      open: 0,
      filled: 0,
      cancelled: 0,
      expired: 0,
    } satisfies Record<Order['status'], number>,
  );
}

export function filterOrdersByStatus(orders: Order[], filter: OrderStatusFilter): Order[] {
  if (filter === 'all') return orders;
  return orders.filter((order) => order.status === filter);
}
