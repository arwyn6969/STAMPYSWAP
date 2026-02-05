import { useState, useEffect, useCallback } from 'react';
import { OrderBook } from './components/OrderBook';
import { TradeForm } from './components/TradeForm';
import { QRSigner } from './components/QRSigner';
import { DepthChart } from './components/DepthChart';
import { BalanceDisplay } from './components/BalanceDisplay';
import { PairSelector } from './components/PairSelector';
import { WalletConnect } from './components/WalletConnect';
import { OpportunityScanner } from './components/OpportunityScanner';
import { type TradeOpportunity } from './lib/agent/OpportunityMatcher';
import { getOrders, type ComposeResult, type Order } from './lib/counterparty';
import './App.css';

function App() {
  const [userAddress, setUserAddress] = useState('');
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
    giveQuantity: number;
    getQuantity: number;
  } | null>(null);

   const fetchOrders = useCallback(async () => {
    if (!asset1 || !asset2) return;
    
    setLoading(true);
    setError(null);
    try {
      const data = await getOrders(asset1, asset2, 'open');
      setOrders(data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect to Counterparty API');
      setOrders([]);
    } finally {
      setLoading(false);
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
    
    let totalGive = 0;
    let totalGet = 0;

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
    // We want to SELL our asset to fill this order
    // They want 'opp.asset' (Get)
    // They give 'opp.order.give_asset' (Give)
    
    // So WE Give: opp.asset
    // WE Get: opp.order.give_asset
    
    setPrefillOrder({
      giveAsset: opp.asset,
      getAsset: opp.order.give_asset,
      giveQuantity: opp.order.get_remaining, // We give what they want
      getQuantity: opp.order.give_remaining  // We get what they give
    });
  };

  return (
    <div className="app">
      <header className="flex justify-between items-center mb-3">
        <div>
          <h1>STAMPYSWAP</h1>
          <p className="text-muted">Counterparty DEX Interface</p>
        </div>
        <WalletConnect
          connectedAddress={userAddress}
          onConnect={(address) => setUserAddress(address)}
          onDisconnect={() => setUserAddress('')}
        />
      </header>

      {/* Pair Selector with Quick Select and Dropdown */}
      <PairSelector
        asset1={asset1}
        asset2={asset2}
        onPairChange={(base, quote) => {
          setAsset1(base);
          setAsset2(quote);
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
      />
    </div>
  );
}

export default App;
