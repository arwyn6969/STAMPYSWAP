/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  getOrders,
  composeOrder,
  type ComposeResult,
  type Order,
} from '../lib/counterparty';
import { type TradeOpportunity } from '../lib/agent/OpportunityMatcher';
import { type MacroOrderParams } from '../components/ShoppingCartMacro';

export interface PrefillOrder {
  giveAsset: string;
  getAsset: string;
  giveQuantity: bigint;
  getQuantity: bigint;
  contextLabel?: string;
}

interface MarketContextValue {
  asset1: string;
  asset2: string;
  setAsset1: (asset: string) => void;
  setAsset2: (asset: string) => void;
  orders: Order[];
  loading: boolean;
  error: string | null;
  lastRefresh: Date | null;
  prefillOrder: PrefillOrder | null;
  composeResult: ComposeResult | null;
  setComposeResult: (result: ComposeResult | null) => void;
  macroQueue: MacroOrderParams[];
  macroError: string | null;
  clearMacroError: () => void;
  fetchOrders: (force?: boolean) => Promise<void>;
  handlePairChange: (base: string, quote: string) => void;
  handleOrderSweep: (target: Order, sweepSet: Order[]) => void;
  handleOrderCompete: (target: Order) => void;
  handleOpportunitySelect: (opp: TradeOpportunity) => void;
  handleExecuteBatch: (params: MacroOrderParams[]) => void;
  clearComposeAndQueue: () => void;
  // Portfolio/cart state (co-located since it feeds into macro queue)
  selectedPortfolioAssets: string[];
  isCartOpen: boolean;
  handleTogglePortfolioAsset: (asset: string) => void;
  clearPortfolioSelection: () => void;
  openCart: () => void;
  closeCart: () => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

export function MarketProvider({
  children,
  userAddress,
}: {
  children: ReactNode;
  userAddress: string;
}) {
  const [asset1, setAsset1] = useState('XCP');
  const [asset2, setAsset2] = useState('PEPECASH');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [prefillOrder, setPrefillOrder] = useState<PrefillOrder | null>(null);
  const [composeResult, setComposeResult] = useState<ComposeResult | null>(null);
  const [selectedPortfolioAssets, setSelectedPortfolioAssets] = useState<string[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [macroQueue, setMacroQueue] = useState<MacroOrderParams[]>([]);
  const [macroError, setMacroError] = useState<string | null>(null);
  const ordersRequestId = useRef(0);

  const fetchOrders = useCallback(async (force = false) => {
    if (!asset1 || !asset2) {
      setOrders([]);
      setLoading(false);
      setLastRefresh(null);
      return;
    }

    const requestId = ++ordersRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getOrders(asset1, asset2, 'open', { force });
      if (requestId !== ordersRequestId.current) return;
      setOrders(data);
      setLastRefresh(new Date());
    } catch (err) {
      if (requestId !== ordersRequestId.current) return;
      setError(err instanceof Error ? err.message : 'Unable to connect to Counterparty API');
      setOrders([]);
    } finally {
      if (requestId === ordersRequestId.current) {
        setLoading(false);
      }
    }
  }, [asset1, asset2]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handlePairChange = useCallback((base: string, quote: string) => {
    ordersRequestId.current += 1;
    setAsset1(base);
    setAsset2(quote);
    setLoading(false);
    setOrders([]);
    setError(null);
    setLastRefresh(null);
    setPrefillOrder(null);
  }, []);

  const handleOrderSweep = useCallback((target: Order, sweepSet: Order[]) => {
    const isAsk = target.give_asset === asset1;
    const effectiveSweepSet = sweepSet.length > 0 ? sweepSet : [target];

    let totalGive = 0n;
    let totalGet = 0n;

    effectiveSweepSet.forEach(o => {
      totalGive += o.give_remaining;
      totalGet += o.get_remaining;
    });

    if (isAsk) {
      setPrefillOrder({
        giveAsset: asset2,
        getAsset: asset1,
        giveQuantity: totalGet,
        getQuantity: totalGive,
        contextLabel: effectiveSweepSet.length > 1
          ? `Sweep ${effectiveSweepSet.length} asks into one draft order`
          : `Fill the selected ask`,
      });
    } else {
      setPrefillOrder({
        giveAsset: asset1,
        getAsset: asset2,
        giveQuantity: totalGet,
        getQuantity: totalGive,
        contextLabel: effectiveSweepSet.length > 1
          ? `Sweep ${effectiveSweepSet.length} bids into one draft order`
          : `Fill the selected bid`,
      });
    }
  }, [asset1, asset2]);

  const handleOrderCompete = useCallback((target: Order) => {
    setPrefillOrder({
      giveAsset: target.give_asset,
      getAsset: target.get_asset,
      giveQuantity: target.give_remaining,
      getQuantity: target.get_remaining,
      contextLabel: 'Copied live order terms from the book',
    });
  }, []);

  const handleOpportunitySelect = useCallback((opp: TradeOpportunity) => {
    setPrefillOrder({
      giveAsset: opp.asset,
      getAsset: opp.getAsset,
      giveQuantity: opp.giveQuantityBase,
      getQuantity: opp.getQuantityBase,
      contextLabel: `Autofilled from ${opp.type === 'buy' ? 'buy' : 'sell'} opportunity scanner`,
    });
  }, []);

  const handleTogglePortfolioAsset = useCallback((asset: string) => {
    setSelectedPortfolioAssets(prev => {
      if (prev.includes(asset)) return prev.filter(a => a !== asset);
      return [...prev, asset];
    });
  }, []);

  const clearPortfolioSelection = useCallback(() => {
    setMacroError(null);
    setSelectedPortfolioAssets([]);
  }, []);

  const clearMacroError = useCallback(() => {
    setMacroError(null);
  }, []);

  const handleExecuteBatch = useCallback((params: MacroOrderParams[]) => {
    setMacroError(null);
    setMacroQueue(params);
    setIsCartOpen(false);
  }, []);

  const clearComposeAndQueue = useCallback(() => {
    setComposeResult(null);
    setMacroError(null);
    if (macroQueue.length > 0) {
      setMacroQueue([]);
    }
  }, [macroQueue.length]);

  // Process macro queue
  useEffect(() => {
    if (macroQueue.length === 0 || composeResult !== null || !userAddress) return;

    let cancelled = false;
    const nextOrder = macroQueue[0];

    const composeNext = async () => {
      try {
        const result = await composeOrder({
          address: userAddress,
          give_asset: nextOrder.give_asset,
          give_quantity: nextOrder.give_quantity,
          get_asset: nextOrder.get_asset,
          get_quantity: nextOrder.get_quantity,
          expiration: nextOrder.expiration,
        });
        if (!cancelled) setComposeResult(result);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setMacroError(`Batch listing stopped while composing ${nextOrder.give_asset}: ${message}`);
          setComposeResult(null);
          setMacroQueue([]);
        }
      }
    };

    void composeNext();
    return () => { cancelled = true; };
  }, [macroQueue, composeResult, userAddress]);

  // Provide a way for TransactionContext to advance the macro queue after broadcast
  // This is exposed via the onTransactionBroadcast callback
  const advanceMacroQueue = useCallback(() => {
    setMacroQueue(prev => {
      if (prev.length > 0) {
        setComposeResult(null);
        return prev.slice(1);
      }
      return prev;
    });
  }, []);

  // Register the advanceMacroQueue with the parent (App) via ref or callback
  // For simplicity, we'll expose it separately
  const value: MarketContextValue = {
    asset1,
    asset2,
    setAsset1,
    setAsset2,
    orders,
    loading,
    error,
    lastRefresh,
    prefillOrder,
    composeResult,
    setComposeResult,
    macroQueue,
    macroError,
    clearMacroError,
    fetchOrders,
    handlePairChange,
    handleOrderSweep,
    handleOrderCompete,
    handleOpportunitySelect,
    handleExecuteBatch,
    clearComposeAndQueue,
    selectedPortfolioAssets,
    isCartOpen,
    handleTogglePortfolioAsset,
    clearPortfolioSelection,
    openCart: useCallback(() => setIsCartOpen(true), []),
    closeCart: useCallback(() => setIsCartOpen(false), []),
  };

  // Expose advanceMacroQueue for transaction broadcast coordination
  (value as MarketContextValue & { advanceMacroQueue: () => void }).advanceMacroQueue = advanceMacroQueue;

  return (
    <MarketContext.Provider value={value}>
      {children}
    </MarketContext.Provider>
  );
}

export function useMarket(): MarketContextValue {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket must be used within a MarketProvider');
  return ctx;
}
