
import { Order, Balance, getOrdersForAsset } from '../counterparty';

export interface TradeOpportunity {
  type: 'buy' | 'sell';
  asset: string;
  quantity: number; // Amount of YOUR asset they want
  price: number;
  order: Order;
  description: string;
}

export class OpportunityMatcher {
  /**
   * Scans for orders that match the user's balances
   * @param balances List of user's asset balances
   * @returns List of opportunities
   */
  static async findMatches(balances: Balance[]): Promise<TradeOpportunity[]> {
    const opportunities: TradeOpportunity[] = [];

    // Filter out minimal balances (dust) to save API calls
    const meaningfulBalances = balances.filter(b => b.quantity > 0);

    // Scan each asset we hold
    for (const balance of meaningfulBalances) {
      // Fetch ANY order involving this asset
      const orders = await getOrdersForAsset(balance.asset);

      for (const order of orders) {
        // CASE 1: They want what we have (We SELL, They BUY)
        // Order `get_asset` matches our `balance.asset`
        if (order.get_asset === balance.asset && order.status === 'open') {
          
          // Calculate price (Their Give / Their Get)
          // "I will give you 0.5 XCP (give) for your 100 PEPE (get)"
          // Price = 0.5 / 100 = 0.005 XCP per PEPE
          const price = order.give_quantity / order.get_quantity;

          opportunities.push({
            type: 'sell',
            asset: balance.asset,
            quantity: order.get_remaining, // They want this much
            price: price,
            order: order,
            description: `Sell ${balance.asset} for ${order.give_asset} @ ${price.toFixed(8)}`
          });
        }
      }
    }

    // Sort by "Price" is tricky because units differ. 
    // For now, prompt the user with the asset name.
    return opportunities;
  }

  /**
   * Groups opportunities by the Asset matching the user's wallet
   */
  static groupByAsset(opportunities: TradeOpportunity[]): Record<string, TradeOpportunity[]> {
    return opportunities.reduce((acc, opp) => {
      if (!acc[opp.asset]) acc[opp.asset] = [];
      acc[opp.asset].push(opp);
      return acc;
    }, {} as Record<string, TradeOpportunity[]>);
  }
}
