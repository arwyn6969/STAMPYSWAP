import { useState, useEffect, useCallback, useRef } from 'react';
import { OrderBook } from './components/OrderBook';
import { TradeForm } from './components/TradeForm';
import { QRSigner } from './components/QRSigner';
import { DepthChart } from './components/DepthChart';
import { BalanceDisplay } from './components/BalanceDisplay';
import { PairSelector } from './components/PairSelector';
import { WalletConnect } from './components/WalletConnect';
import { OpportunityScanner } from './components/OpportunityScanner';
import { type TradeOpportunity } from './lib/agent/OpportunityMatcher';
import {
  getOrders,
  getTransactionStatus,
  type ComposeResult,
  type Order,
  type TransactionState,
  type TransactionStatus,
} from './lib/counterparty';
import './App.css';

type TrackedLifecycle = 'broadcasted' | TransactionStatus;

interface TrackedTransaction {
  txid: string;
  status: TrackedLifecycle;
  confirmations: number;
  source?: TransactionState['source'];
  lastChecked: Date | null;
  error: string | null;
}

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
  const [trackedTx, setTrackedTx] = useState<TrackedTransaction | null>(null);
  const ordersRequestId = useRef(0);

  const handleWalletConnect = useCallback((address: string, canSign = false) => {
    setUserAddress(address);
    setWalletCanSign(canSign);
  }, []);

  const handleWalletDisconnect = useCallback(() => {
    setUserAddress('');
    setWalletCanSign(false);
    setComposeResult(null);
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

  const handleOpportunitySelect = (opp: TradeOpportunity) => {
    setPrefillOrder({
      giveAsset: opp.asset,
      getAsset: opp.getAsset,
      giveQuantity: opp.giveQuantityBase,
      getQuantity: opp.getQuantityBase,
    });
  };

  const handleTransactionBroadcast = useCallback((txid: string) => {
    setTrackedTx({
      txid,
      status: 'broadcasted',
      confirmations: 0,
      lastChecked: new Date(),
      error: null,
    });
  }, []);

  const refreshTrackedTx = useCallback(async () => {
    const txid = trackedTx?.txid;
    if (!txid) return;

    setTrackedTx((prev) => {
      if (!prev || prev.txid !== txid) return prev;
      return { ...prev, error: null };
    });

    try {
      const state = await getTransactionStatus(txid);
      setTrackedTx((prev) => {
        if (!prev || prev.txid !== txid) return prev;
        return {
          ...prev,
          status: state.status,
          confirmations: state.confirmations,
          source: state.source,
          lastChecked: new Date(),
          error: null,
        };
      });

      if (state.status === 'confirmed') {
        void fetchOrders();
      }
    } catch (err) {
      setTrackedTx((prev) => {
        if (!prev || prev.txid !== txid) return prev;
        return {
          ...prev,
          lastChecked: new Date(),
          error: err instanceof Error ? err.message : 'Unable to refresh transaction status',
        };
      });
    }
  }, [trackedTx?.txid, fetchOrders]);

  useEffect(() => {
    if (!trackedTx?.txid) return;
    if (trackedTx.status === 'confirmed' || trackedTx.status === 'failed') return;

    void refreshTrackedTx();
    const timerId = window.setInterval(() => {
      void refreshTrackedTx();
    }, 15000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [trackedTx?.txid, trackedTx?.status, refreshTrackedTx]);

  const getTrackedStatusMessage = useCallback((tx: TrackedTransaction): string => {
    if (tx.status === 'confirmed') {
      const suffix = tx.confirmations === 1 ? '' : 's';
      return `Confirmed (${tx.confirmations} confirmation${suffix}).`;
    }
    if (tx.status === 'mempool') {
      return 'In mempool. Waiting for first confirmation.';
    }
    if (tx.status === 'failed') {
      return 'Transaction appears rejected or dropped.';
    }
    if (tx.status === 'unknown') {
      return 'Broadcasted, but network status is currently unknown.';
    }
    return 'Broadcasted. Waiting for mempool visibility.';
  }, []);

  const trackedTxStatusClass = trackedTx?.status === 'confirmed'
    ? 'badge-success'
    : trackedTx?.status === 'failed'
      ? 'text-error'
      : 'badge-primary';

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
        <WalletConnect
          connectedAddress={userAddress}
          onConnect={handleWalletConnect}
          onDisconnect={handleWalletDisconnect}
        />
      </header>

      {/* Pair Selector with Quick Select and Dropdown */}
      <PairSelector
        asset1={asset1}
        asset2={asset2}
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

      {trackedTx && (
        <div className="card mb-2">
          <div className="flex justify-between items-center mb-1">
            <h3>Latest Transaction</h3>
            <span className={`badge ${trackedTxStatusClass}`}>{trackedTx.status.toUpperCase()}</span>
          </div>
          <div className="text-muted mb-1" style={{ fontSize: '0.75rem' }}>
            Tx: {trackedTx.txid}
          </div>
          <div className="mb-1" style={{ fontSize: '0.875rem' }}>
            {getTrackedStatusMessage(trackedTx)}
          </div>
          {trackedTx.source && (
            <div className="text-muted mb-1" style={{ fontSize: '0.75rem' }}>
              Source: {trackedTx.source}
            </div>
          )}
          {trackedTx.lastChecked && (
            <div className="text-muted mb-1" style={{ fontSize: '0.75rem' }}>
              Last checked: {trackedTx.lastChecked.toLocaleTimeString()}
            </div>
          )}
          {trackedTx.error && (
            <div className="text-error mb-1" style={{ fontSize: '0.75rem' }}>
              {trackedTx.error}
            </div>
          )}
          <div className="flex gap-1">
            <button
              className="btn-secondary"
              onClick={() => void refreshTrackedTx()}
              disabled={trackedTx.status === 'confirmed' || trackedTx.status === 'failed'}
            >
              Refresh Status
            </button>
            <a
              className="btn-secondary"
              href={`https://mempool.space/tx/${trackedTx.txid}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              Open Explorer
            </a>
            <button className="btn-secondary" onClick={() => setTrackedTx(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

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
        />
        <TradeForm 
          userAddress={userAddress} 
          onOrderComposed={setComposeResult}
          giveAssetDefault={asset1}
          getAssetDefault={asset2}
          prefill={prefillOrder}
        />
        <div className="flex flex-col gap-2">
          <OpportunityScanner 
             userAddress={userAddress} 
             onSelect={handleOpportunitySelect}
          />
          <BalanceDisplay userAddress={userAddress} />
        </div>
      </div>

      {/* QR Signer Modal */}
      <QRSigner 
        composeResult={composeResult} 
        onClose={() => setComposeResult(null)}
        onBroadcast={handleTransactionBroadcast}
        onTrackTxid={handleTransactionBroadcast}
      />
    </div>
  );
}

export default App;
