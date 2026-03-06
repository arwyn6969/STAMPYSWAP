import {
  type Order,
  type Balance,
  getAssetDivisibility,
  getOrdersForAsset,
  getAllOpenOrders,
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
  getAllOpenOrders: () => Promise<Order[]>;
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
      getAllOpenOrders,
      getAssetDivisibility,
    },
    assetFilter?: string,
  ): Promise<TradeOpportunity[]> {
    const opportunities: TradeOpportunity[] = [];

    // Merge duplicate assets and skip zero balances.
    const balanceByAsset = new Map<string, bigint>();
    for (const balance of balances) {
      if (balance.quantity <= 0n) continue;
      const key = balance.asset.toUpperCase();
      if (assetFilter && key !== assetFilter.toUpperCase()) continue;
      balanceByAsset.set(key, (balanceByAsset.get(key) ?? 0n) + balance.quantity);
    }

    const assets = Array.from(balanceByAsset.keys());
    if (assets.length === 0) return [];

    const assetDivEntries = await Promise.all(
      assets.map(async (asset) => [asset, await provider.getAssetDivisibility(asset)] as const),
    );
    const assetDivisibility = new Map(assetDivEntries);

    // Fetch all open orders on the DEX in one go (optimizes away hundreds of per-asset API calls)
    const allOpenOrders = await provider.getAllOpenOrders();

    // Group the all open orders into the asset buckets the user actually holds
    const ordersByAsset: Array<[string, Order[]]> = [];
    for (const asset of assets) {
      const matches = allOpenOrders.filter(o => o.get_asset.toUpperCase() === asset);
      ordersByAsset.push([asset, matches]);
    }

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

  /**
   * Scans for orders that are SELLING assets the user wants to buy.
   * Returns opportunities where:
   *   - The order gives an asset on the user's wishlist
   *   - The order wants an asset the user actually holds
   *   - The user can afford to (partially) fill the order
   *
   * @param wishlist Assets the user wants to acquire
   * @param balances User's current holdings (determines budget)
   * @param provider Data provider (injectable for testing)
   * @param maxPerAsset Maximum results per wishlist asset (default 10)
   */
  static async findBuyOpportunities(
    wishlist: string[],
    balances: Balance[],
    provider: OpportunityDataProvider = {
      getOrdersForAsset,
      getAllOpenOrders,
      getAssetDivisibility,
    },
    maxPerAsset = 10,
  ): Promise<TradeOpportunity[]> {
    // Normalize wishlist
    const wantSet = new Set(wishlist.map(a => a.trim().toUpperCase()).filter(Boolean));
    if (wantSet.size === 0) return [];

    // Build budget map from user balances
    const budgetByAsset = new Map<string, bigint>();
    for (const balance of balances) {
      if (balance.quantity <= 0n) continue;
      const key = balance.asset.toUpperCase();
      budgetByAsset.set(key, (budgetByAsset.get(key) ?? 0n) + balance.quantity);
    }

    if (budgetByAsset.size === 0) return [];

    // Pre-fetch divisibility for all user-held assets + wishlist assets
    const allRelevantAssets = new Set([...budgetByAsset.keys(), ...wantSet]);
    const divEntries = await Promise.all(
      Array.from(allRelevantAssets).map(
        async (asset) => [asset, await provider.getAssetDivisibility(asset)] as const,
      ),
    );
    const divisibilityMap = new Map(divEntries);

    // Fetch all open orders
    const allOpenOrders = await provider.getAllOpenOrders();

    // Filter orders: must be selling a wishlist asset AND wanting something we hold
    const relevantOrders = allOpenOrders.filter(order => {
      if (order.status !== 'open') return false;
      if (order.give_remaining <= 0n || order.get_remaining <= 0n) return false;
      const givesAsset = order.give_asset.toUpperCase();
      const wantsAsset = order.get_asset.toUpperCase();
      return wantSet.has(givesAsset) && budgetByAsset.has(wantsAsset);
    });

    const opportunities: TradeOpportunity[] = [];
    const countByDesired = new Map<string, number>();

    for (const order of relevantOrders) {
      const desiredAsset = order.give_asset.toUpperCase(); // What we want to BUY
      const paymentAsset = order.get_asset.toUpperCase();  // What we PAY with

      // Respect per-asset cap
      const currentCount = countByDesired.get(desiredAsset) ?? 0;
      if (currentCount >= maxPerAsset) continue;

      // How much can we afford?
      const userBudget = budgetByAsset.get(paymentAsset) ?? 0n;
      if (userBudget <= 0n) continue;

      const payQuantityBase = minBaseUnits(userBudget, order.get_remaining);
      if (payQuantityBase <= 0n) continue;

      const receiveQuantityBase = scaleBaseUnitsFloor(
        payQuantityBase,
        order.give_remaining,
        order.get_remaining,
      );
      if (receiveQuantityBase <= 0n) continue;

      const paymentDivisible = divisibilityMap.get(paymentAsset) ?? true;
      const desiredDivisible = divisibilityMap.get(desiredAsset) ?? true;

      // Price = how much payment per unit of desired asset
      const price = calculatePrice(
        payQuantityBase,
        paymentDivisible,
        receiveQuantityBase,
        desiredDivisible,
      );

      const quantity = baseUnitsToNumber(payQuantityBase, paymentDivisible);
      const expectedReturn = baseUnitsToNumber(receiveQuantityBase, desiredDivisible);

      opportunities.push({
        type: 'buy',
        asset: paymentAsset,       // What user gives (payment)
        getAsset: desiredAsset,    // What user receives (desired)
        quantity,                  // Display: payment amount
        expectedReturn,            // Display: receive amount
        giveQuantityBase: payQuantityBase,
        getQuantityBase: receiveQuantityBase,
        price,
        order,
        description: `Buy ${desiredAsset} with ${paymentAsset} @ ${price.toFixed(8)}`,
      });

      countByDesired.set(desiredAsset, currentCount + 1);
    }

    // Sort by cheapest price first (best deals at top)
    return opportunities.sort((a, b) => a.price - b.price);
  }
}
