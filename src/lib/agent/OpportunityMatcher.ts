import {
  type Order,
  type Balance,
  getAssetDivisibility,
  getOrdersForAsset,
} from '../counterparty.js';
import {
  baseUnitsToNumber,
  calculatePrice,
  minBaseUnits,
  scaleBaseUnitsFloor,
} from '../quantity.js';

export interface TradeOpportunity {
  type: 'buy' | 'sell';
  asset: string; // Asset you will give
  getAsset: string; // Asset you will receive
  quantity: number; // Display quantity you can sell
  expectedReturn: number; // Display quantity you can receive
  giveQuantityBase: bigint; // Base units for compose API
  getQuantityBase: bigint; // Base units for compose API
  price: number;
  order: Order;
  description: string;
}

interface OpportunityDataProvider {
  getOrdersForAsset: (asset: string) => Promise<Order[]>;
  getAssetDivisibility: (asset: string) => Promise<boolean>;
}

export class OpportunityMatcher {
  /**
   * Scans for orders that match the user's balances
   * @param balances List of user's asset balances
   * @returns List of opportunities
   */
  static async findMatches(
    balances: Balance[],
    provider: OpportunityDataProvider = {
      getOrdersForAsset,
      getAssetDivisibility,
    },
  ): Promise<TradeOpportunity[]> {
    const opportunities: TradeOpportunity[] = [];

    // Merge duplicate assets and skip zero balances.
    const balanceByAsset = new Map<string, bigint>();
    for (const balance of balances) {
      if (balance.quantity <= 0n) continue;
      const key = balance.asset.toUpperCase();
      balanceByAsset.set(key, (balanceByAsset.get(key) ?? 0n) + balance.quantity);
    }

    const assets = Array.from(balanceByAsset.keys());
    if (assets.length === 0) return [];

    const assetDivEntries = await Promise.all(
      assets.map(async (asset) => [asset, await provider.getAssetDivisibility(asset)] as const),
    );
    const assetDivisibility = new Map(assetDivEntries);

    const ordersByAsset = await Promise.all(
      assets.map(async (asset) => [asset, await provider.getOrdersForAsset(asset)] as const),
    );

    for (const [asset, orders] of ordersByAsset) {
      const balanceQuantity = balanceByAsset.get(asset) ?? 0n;
      const assetIsDivisible = assetDivisibility.get(asset) ?? true;
      const quoteAssets = Array.from(new Set(orders.map((order) => order.give_asset.toUpperCase())));
      const quoteDivEntries = await Promise.all(
        quoteAssets.map(async (quoteAsset) => [quoteAsset, await provider.getAssetDivisibility(quoteAsset)] as const),
      );
      const quoteDivisibility = new Map(quoteDivEntries);

      for (const order of orders) {
        if (order.status !== 'open') continue;
        if (order.get_asset.toUpperCase() !== asset) continue;
        if (order.get_remaining <= 0n || order.give_remaining <= 0n) continue;

        // Respect wallet balance and create a partially fillable quote when needed.
        const giveQuantityBase = minBaseUnits(balanceQuantity, order.get_remaining);
        if (giveQuantityBase <= 0n) continue;

        const getQuantityBase = scaleBaseUnitsFloor(
          giveQuantityBase,
          order.give_remaining,
          order.get_remaining,
        );
        if (getQuantityBase <= 0n) continue;

        const quoteAsset = order.give_asset.toUpperCase();
        const quoteIsDivisible = quoteDivisibility.get(quoteAsset) ?? true;
        const price = calculatePrice(
          getQuantityBase,
          quoteIsDivisible,
          giveQuantityBase,
          assetIsDivisible,
        );
        const quantity = baseUnitsToNumber(giveQuantityBase, assetIsDivisible);
        const expectedReturn = baseUnitsToNumber(getQuantityBase, quoteIsDivisible);

        opportunities.push({
          type: 'sell',
          asset,
          getAsset: quoteAsset,
          quantity,
          expectedReturn,
          giveQuantityBase,
          getQuantityBase,
          price,
          order,
          description: `Sell ${asset} for ${quoteAsset} @ ${price.toFixed(8)}`,
        });
      }
    }

    return opportunities.sort((a, b) => b.expectedReturn - a.expectedReturn);
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
