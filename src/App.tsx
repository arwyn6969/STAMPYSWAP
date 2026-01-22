import { useState, useEffect, useCallback } from 'react';
import { OrderBook } from './components/OrderBook';
import { TradeForm } from './components/TradeForm';
import { QRSigner } from './components/QRSigner';
import { DepthChart } from './components/DepthChart';
import { BalanceDisplay } from './components/BalanceDisplay';
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

  // Fetch orders when pair changes
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

  const handleConnect = () => {
    const demoAddress = prompt('Enter your Bitcoin address:');
    if (demoAddress) {
      setUserAddress(demoAddress);
    }
  };

  return (
    <div className="app">
      <header className="flex justify-between items-center mb-3">
        <div>
          <h1>STAMPYSWAP</h1>
          <p className="text-muted">Counterparty DEX Interface</p>
        </div>
        <div>
          {userAddress ? (
            <div className="flex items-center gap-1">
              <span className="badge">{userAddress.slice(0, 8)}...{userAddress.slice(-6)}</span>
              <button className="btn-secondary" onClick={() => setUserAddress('')}>
                Disconnect
              </button>
            </div>
          ) : (
            <button className="btn-primary" onClick={handleConnect}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* Pair Selector */}
      <div className="card mb-2">
        <div className="flex justify-between items-center mb-1">
          <h3>Trading Pair</h3>
          <div className="flex items-center gap-1">
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
        </div>
        <div className="grid-2">
          <div>
            <label>Base Asset</label>
            <input
              type="text"
              value={asset1}
              onChange={(e) => setAsset1(e.target.value.toUpperCase())}
              placeholder="e.g. XCP"
            />
          </div>
          <div>
            <label>Quote Asset</label>
            <input
              type="text"
              value={asset2}
              onChange={(e) => setAsset2(e.target.value.toUpperCase())}
              placeholder="e.g. PEPECASH"
            />
          </div>
        </div>
      </div>

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
        <OrderBook orders={orders} asset1={asset1} asset2={asset2} loading={loading} error={error} />
        <TradeForm 
          userAddress={userAddress} 
          onOrderComposed={setComposeResult}
          giveAssetDefault={asset1}
          getAssetDefault={asset2}
        />
        <BalanceDisplay userAddress={userAddress} />
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
