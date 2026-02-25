import { useState, useEffect, useCallback, useRef } from 'react';
import { OrderBook } from './components/OrderBook';
import { TradeForm } from './components/TradeForm';
import { QRSigner } from './components/QRSigner';
import { DepthChart } from './components/DepthChart';
import { PortfolioGrid } from './components/PortfolioGrid';
import { PairSelector } from './components/PairSelector';
import { WatchlistToolbar } from './components/WatchlistToolbar';
import { useWatchlist } from './hooks/useWatchlist';
import { WalletConnect } from './components/WalletConnect';
import { OpportunityScanner } from './components/OpportunityScanner';
import { TransactionDrawer, type TrackedTransaction } from './components/TransactionDrawer';
import { ShoppingCartMacro, type MacroOrderParams } from './components/ShoppingCartMacro';
import { type TradeOpportunity } from './lib/agent/OpportunityMatcher';
import {
  getOrders,
  getTransactionStatus,
  composeOrder,
  type ComposeResult,
  type Order,
  type TransactionStatus,
} from './lib/counterparty';
import './App.css';

export type TrackedLifecycle = 'broadcasted' | TransactionStatus;

function App() {
  const [userAddress, setUserAddress] = useState('');
  const [walletCanSign, setWalletCanSign] = useState(false);
  const [asset1, setAsset1] = useState('XCP');
  const [asset2, setAsset2] = useState('PEPECASH');
  const [composeResult, setComposeResult] = useState<ComposeResult | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [prefillOrder, setPrefillOrder] = useState<{
    giveAsset: string;
    getAsset: string;
    giveQuantity: bigint;
    getQuantity: bigint;
  } | null>(null);
  const [trackedTxs, setTrackedTxs] = useState<TrackedTransaction[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [selectedPortfolioAssets, setSelectedPortfolioAssets] = useState<string[]>([]);
  const [macroQueue, setMacroQueue] = useState<MacroOrderParams[]>([]);
  const { watchlist, isStarred, togglePair, removePair } = useWatchlist();
  const ordersRequestId = useRef(0);

  const handleWalletConnect = useCallback((address: string, canSign = false) => {
    setUserAddress(address);
    setWalletCanSign(canSign);
  }, []);

  const handleWalletDisconnect = useCallback(() => {
    setUserAddress('');
    setWalletCanSign(false);
    setComposeResult(null);
    setSelectedPortfolioAssets([]);
    setIsCartOpen(false);
  }, []);

  const fetchOrders = useCallback(async () => {
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
      const data = await getOrders(asset1, asset2, 'open');
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

  const handleOrderSweep = (target: Order, sweepSet: Order[]) => {
    // Calculate the 'Counter Order' required to fill this sweep
    // If we are sweeping ASKS (Sellers): We are BUYING.
    // We Give: Quote Asset (e.g. PEPE)
    // We Get: Base Asset (e.g. XCP)
    // Note: Counterparty terminology is from the Order Creator's perspective.
    
    const isAsk = target.give_asset === asset1;
    
    let totalGive = 0n;
    let totalGet = 0n;

    sweepSet.forEach(o => {
      // Aggregate the AMOUNTS from the existing orders
      totalGive += o.give_remaining; // They Give X
      totalGet += o.get_remaining;   // They Get Y
    });

    // Our Order (The Counter) inverses the specific assets
    if (isAsk) {
      // They are Selling Asset1 (Give) for Asset2 (Get)
      // We want to BUY Asset1.
      // So We Give: Asset2 (Their Get)
      // We Get: Asset1 (Their Give)
      setPrefillOrder({
        giveAsset: asset2,
        getAsset: asset1,
        giveQuantity: totalGet, // We match what they want
        getQuantity: totalGive  // We request what they have
      });
    } else {
      // They are Buying Asset1
      // We want to SELL Asset1
      setPrefillOrder({
        giveAsset: asset1,
        getAsset: asset2,
        giveQuantity: totalGet, // We give what they want
        getQuantity: totalGive  // We get what they offer
      });
    }
  };

  const handleOrderCompete = (target: Order) => {
    // Copy the exact parameters of the target order to easily create a competing order
    setPrefillOrder({
      giveAsset: target.give_asset,
      getAsset: target.get_asset,
      giveQuantity: target.give_remaining,
      getQuantity: target.get_remaining,
    });
  };

  const handleOpportunitySelect = (opp: TradeOpportunity) => {
    setPrefillOrder({
      giveAsset: opp.asset,
      getAsset: opp.getAsset,
      giveQuantity: opp.giveQuantityBase,
      getQuantity: opp.getQuantityBase,
    });
  };

  const handleTogglePortfolioAsset = useCallback((asset: string) => {
    setSelectedPortfolioAssets(prev => {
      if (prev.includes(asset)) return prev.filter(a => a !== asset);
      return [...prev, asset];
    });
  }, []);

  const handleTransactionBroadcast = useCallback((txid: string) => {
    setTrackedTxs(prev => {
      if (prev.some(t => t.txid === txid)) return prev;
      return [{
        txid,
        status: 'broadcasted',
        confirmations: 0,
        lastChecked: new Date(),
        error: null,
      }, ...prev];
    });
    setIsDrawerOpen(true);
    
    // Automatically proceed to the next macro after broadcast
    setMacroQueue(prev => {
      if (prev.length > 0) {
        setComposeResult(null); // Auto-close QR modal if there are more items to sign
        return prev.slice(1);
      }
      return prev;
    });
  }, []);

  const refreshTrackedTx = useCallback(async (txid: string) => {
    try {
      const state = await getTransactionStatus(txid);
      setTrackedTxs(prev => prev.map(tx => {
        if (tx.txid !== txid) return tx;
        return {
          ...tx,
          status: state.status,
          confirmations: state.confirmations,
          source: state.source,
          lastChecked: new Date(),
          error: null,
        };
      }));

      if (state.status === 'confirmed') {
        void fetchOrders();
      }
    } catch (err) {
      setTrackedTxs(prev => prev.map(tx => {
        if (tx.txid !== txid) return tx;
        return {
          ...tx,
          lastChecked: new Date(),
          error: err instanceof Error ? err.message : 'Unable to refresh transaction status',
        };
      }));
    }
  }, [fetchOrders]);

  useEffect(() => {
    const pendingTxs = trackedTxs.filter(tx => tx.status !== 'confirmed' && tx.status !== 'failed');
    if (pendingTxs.length === 0) return;

    // Refresh immediately for new ones
    for (const tx of pendingTxs) {
      void refreshTrackedTx(tx.txid);
    }

    const timerId = window.setInterval(() => {
      for (const tx of pendingTxs) {
        void refreshTrackedTx(tx.txid);
      }
    }, 15000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [trackedTxs, refreshTrackedTx]);

  const handleDismissTx = useCallback((txid: string) => {
    setTrackedTxs(prev => prev.filter(tx => tx.txid !== txid));
  }, []);

  const handleClearCompleted = useCallback(() => {
    setTrackedTxs(prev => prev.filter(tx => tx.status !== 'confirmed' && tx.status !== 'failed'));
  }, []);

  const pendingCount = trackedTxs.filter(t => t.status !== 'confirmed' && t.status !== 'failed').length;

  // Process macro queue when it changes
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
          expiration: nextOrder.expiration
        });
        if (!cancelled) setComposeResult(result);
      } catch (err) {
        if (!cancelled) {
          alert(`Failed to compose order for ${nextOrder.give_asset}: ${err instanceof Error ? err.message : String(err)}`);
          // Shift and continue? Or stop? Let's stop the queue on error to be safe.
          setMacroQueue([]);
        }
      }
    };
    
    void composeNext();
    
    return () => { cancelled = true; };
  }, [macroQueue, composeResult, userAddress]);

  const handleExecuteBatch = useCallback((params: MacroOrderParams[]) => {
    setMacroQueue(params);
    setSelectedPortfolioAssets([]); // clear selection
    setIsCartOpen(false); // close cart
  }, []);

  return (
    <div className="app">
      <header className="flex justify-between items-center mb-3">
        <div>
          <h1>STAMPYSWAP</h1>
          <p className="text-muted">Counterparty DEX Interface</p>
          {userAddress && !walletCanSign && (
            <p className="text-warning" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
              Watch-only mode: sign transactions via Freewallet QR.
            </p>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <button 
            className="btn-secondary flex items-center gap-1" 
            style={{ padding: '0.375rem 0.75rem', position: 'relative' }}
            onClick={() => setIsDrawerOpen(true)}
          >
            📋 Tx Center
            {pendingCount > 0 && (
              <span className="badge badge-primary absolute -top-2 -right-2 rounded-full px-1.5 min-w-[1.25rem] h-5 flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>
          <WalletConnect
            connectedAddress={userAddress}
            onConnect={handleWalletConnect}
            onDisconnect={handleWalletDisconnect}
          />
        </div>
      </header>

      <WatchlistToolbar 
        watchlist={watchlist}
        currentBase={asset1}
        currentQuote={asset2}
        onSelectPair={(base, quote) => {
          ordersRequestId.current += 1;
          setAsset1(base);
          setAsset2(quote);
          setLoading(false);
          setOrders([]);
          setError(null);
          setLastRefresh(null);
          setPrefillOrder(null);
        }}
        onRemovePair={removePair}
      />

      {/* Pair Selector with Quick Select and Dropdown */}
      <PairSelector
        asset1={asset1}
        asset2={asset2}
        isStarred={isStarred(asset1, asset2)}
        onToggleStar={() => togglePair(asset1, asset2)}
        onPairChange={(base, quote) => {
          ordersRequestId.current += 1;
          setAsset1(base);
          setAsset2(quote);
          setLoading(false);
          setOrders([]);
          setError(null);
          setLastRefresh(null);
          setPrefillOrder(null);
        }}
      />

      {/* Refresh Button */}
      {asset1 && asset2 && (
        <div className="flex justify-end items-center gap-1 mb-2">
          {lastRefresh && (
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button 
            className="btn-icon" 
            onClick={fetchOrders}
            disabled={loading}
            title="Refresh orders"
          >
            {loading ? <span className="spinner"></span> : '↻'}
          </button>
        </div>
      )}

      {/* Removed old single trackedTx card */}

      {/* Depth Chart - Visual price/depth display */}
      <div className="card mb-2">
        <h2 className="mb-1">Market Depth</h2>
        {loading && (
          <div className="loading-state">
            <span className="spinner spinner-lg"></span>
            <span className="text-muted">Loading market data...</span>
          </div>
        )}
        {error && (
          <div className="empty-state">
            <div className="empty-state-icon">⚠️</div>
            <div className="empty-state-title">Connection Error</div>
            <div className="empty-state-text">{error}</div>
            <button className="btn-secondary" onClick={fetchOrders}>Try Again</button>
          </div>
        )}
        {!loading && !error && orders.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <div className="empty-state-title">No Open Orders</div>
            <div className="empty-state-text">
              Be the first to create an order for {asset1}/{asset2}!
            </div>
          </div>
        )}
        {!loading && !error && orders.length > 0 && (
          <DepthChart orders={orders} asset1={asset1} asset2={asset2} />
        )}
      </div>

      {/* Main Grid */}
      <div className="grid-3 gap-2">
        <OrderBook 
          orders={orders} 
          asset1={asset1} 
          asset2={asset2} 
          loading={loading} 
          error={error}
          onOrderClick={handleOrderSweep} 
          onOrderCompete={handleOrderCompete}
        />
        <TradeForm 
          userAddress={userAddress} 
          onOrderComposed={setComposeResult}
          giveAssetDefault={asset1}
          getAssetDefault={asset2}
          prefill={prefillOrder}
          orders={orders}
        />
        <div className="flex flex-col gap-2">
          <PortfolioGrid 
            userAddress={userAddress} 
            selectedAssets={selectedPortfolioAssets}
            onToggleAsset={handleTogglePortfolioAsset}
            onClearSelection={() => setSelectedPortfolioAssets([])}
            onProceedToCart={() => setIsCartOpen(true)}
          />
          <OpportunityScanner 
             userAddress={userAddress} 
             onSelect={handleOpportunitySelect}
             assetFilter={selectedPortfolioAssets.length === 1 ? selectedPortfolioAssets[0] : null}
          />
        </div>
      </div>

      {/* QR Signer Modal */}
      <QRSigner 
        composeResult={composeResult} 
        onClose={() => {
          setComposeResult(null);
          if (macroQueue.length > 0) {
            // Cancel the queue if user dismisses modal
            setMacroQueue([]);
          }
        }}
        onBroadcast={handleTransactionBroadcast}
        onTrackTxid={handleTransactionBroadcast}
      />

      <TransactionDrawer 
        transactions={trackedTxs}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onDismiss={handleDismissTx}
        onRefresh={refreshTrackedTx}
        onClearCompleted={handleClearCompleted}
      />

      <ShoppingCartMacro 
        userAddress={userAddress}
        selectedAssets={selectedPortfolioAssets}
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        onExecuteBatch={handleExecuteBatch}
      />
    </div>
  );
}

export default App;
