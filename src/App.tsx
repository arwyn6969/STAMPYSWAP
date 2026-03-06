import { useCallback } from 'react';
import { OrderBook } from './components/OrderBook';
import { TradeForm } from './components/TradeForm';
import { QRSigner } from './components/QRSigner';
import { DepthChart } from './components/DepthChart';
import { PortfolioGrid } from './components/PortfolioGrid';
import { PairSelector } from './components/PairSelector';
import { WatchlistToolbar } from './components/WatchlistToolbar';
import { useWatchlist } from './hooks/useWatchlist';
import { useWishlist } from './hooks/useWishlist';
import { WalletConnect } from './components/WalletConnect';
import { OpportunityScanner } from './components/OpportunityScanner';
import { BuyOpportunityScanner } from './components/BuyOpportunityScanner';
import { OrderHistory } from './components/OrderHistory';
import { TransactionDrawer } from './components/TransactionDrawer';
import { ShoppingCartMacro } from './components/ShoppingCartMacro';
import {
  type TransactionStatus,
  getIsTestnet,
  setTestnet,
} from './lib/counterparty';
import { WalletProvider, useWallet } from './contexts/WalletContext';
import { MarketProvider, useMarket } from './contexts/MarketContext';
import { TransactionProvider, useTransactions } from './contexts/TransactionContext';
import './App.css';

export type TrackedLifecycle = 'broadcasted' | TransactionStatus;

/**
 * Inner app that consumes all three contexts.
 */
function AppContent() {
  const { userAddress, walletCanSign, connect, disconnect } = useWallet();
  const market = useMarket();
  const txCtx = useTransactions();
  const { watchlist, isStarred, togglePair, removePair } = useWatchlist();
  const {
    wishlist: buyWishlist,
    addAsset: addToWishlist,
    removeAsset: removeFromWishlist,
  } = useWishlist();

  const {
    asset1, asset2,
    orders, loading, error, lastRefresh,
    prefillOrder, composeResult, setComposeResult,
    fetchOrders,
    handlePairChange,
    handleOrderSweep, handleOrderCompete, handleOpportunitySelect,
    handleExecuteBatch,
    clearComposeAndQueue,
    selectedPortfolioAssets, isCartOpen,
    handleTogglePortfolioAsset, clearPortfolioSelection,
    openCart, closeCart,
  } = market;

  const {
    trackedTxs, isDrawerOpen, pendingCount,
    openDrawer, closeDrawer,
    broadcast, refreshTx, dismissTx, clearCompleted,
  } = txCtx;

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
            onClick={openDrawer}
          >
            📋 Tx Center
            {pendingCount > 0 && (
              <span className="badge badge-primary absolute -top-2 -right-2 rounded-full px-1.5 min-w-[1.25rem] h-5 flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>
          
          {/* Testnet Toggle */}
          <div className="flex items-center gap-2 px-3 py-1 bg-base-100 border border-[var(--border-color)] rounded">
            <label className="text-xs font-bold uppercase tracking-wider text-muted cursor-pointer" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Testnet
              <input 
                type="checkbox" 
                checked={getIsTestnet()} 
                onChange={(e) => {
                  setTestnet(e.target.checked);
                  window.location.reload();
                }}
                style={{ cursor: 'pointer' }}
              />
            </label>
          </div>

          <WalletConnect
            connectedAddress={userAddress}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </div>
      </header>

      <WatchlistToolbar 
        watchlist={watchlist}
        currentBase={asset1}
        currentQuote={asset2}
        onSelectPair={handlePairChange}
        onRemovePair={removePair}
      />

      {/* Pair Selector with Quick Select and Dropdown */}
      <PairSelector
        asset1={asset1}
        asset2={asset2}
        isStarred={isStarred(asset1, asset2)}
        onToggleStar={() => togglePair(asset1, asset2)}
        onPairChange={handlePairChange}
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

      {/* Depth Chart */}
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
            onClearSelection={clearPortfolioSelection}
            onProceedToCart={openCart}
          />
          <OpportunityScanner 
             userAddress={userAddress} 
             onSelect={handleOpportunitySelect}
             assetFilter={selectedPortfolioAssets.length === 1 ? selectedPortfolioAssets[0] : null}
          />
          <BuyOpportunityScanner
            userAddress={userAddress}
            wishlist={buyWishlist}
            onSelect={handleOpportunitySelect}
            onAddToWishlist={addToWishlist}
            onRemoveFromWishlist={removeFromWishlist}
          />
          <OrderHistory
            userAddress={userAddress}
            onViewPair={handlePairChange}
          />
        </div>
      </div>

      {/* QR Signer Modal */}
      <QRSigner 
        composeResult={composeResult} 
        onClose={clearComposeAndQueue}
        onBroadcast={broadcast}
        onTrackTxid={broadcast}
      />

      <TransactionDrawer 
        transactions={trackedTxs}
        isOpen={isDrawerOpen}
        onClose={closeDrawer}
        onDismiss={dismissTx}
        onRefresh={refreshTx}
        onClearCompleted={clearCompleted}
      />

      <ShoppingCartMacro 
        userAddress={userAddress}
        selectedAssets={selectedPortfolioAssets}
        isOpen={isCartOpen}
        onClose={closeCart}
        onExecuteBatch={handleExecuteBatch}
      />
    </div>
  );
}

/**
 * App wraps AppContent in context providers.
 * Cross-context coordination is handled via callbacks.
 */
function App() {
  return (
    <WalletProvider>
      <AppInner />
    </WalletProvider>
  );
}

function AppInner() {
  const { userAddress } = useWallet();

  return (
    <MarketProvider userAddress={userAddress}>
      <TransactionProviderWithMarket>
        <AppContent />
      </TransactionProviderWithMarket>
    </MarketProvider>
  );
}

/**
 * Bridge component that connects TransactionContext to MarketContext
 * for cross-context coordination (e.g., refetch orders on confirm,
 * advance macro queue on broadcast).
 */
function TransactionProviderWithMarket({ children }: { children: React.ReactNode }) {
  const market = useMarket();
  
  const handleConfirmed = useCallback(() => {
    void market.fetchOrders();
  }, [market]);

  const handleBroadcast = useCallback(() => {
    // Advance the macro queue after each broadcast
    const m = market as typeof market & { advanceMacroQueue?: () => void };
    m.advanceMacroQueue?.();
  }, [market]);

  return (
    <TransactionProvider onConfirmed={handleConfirmed} onBroadcast={handleBroadcast}>
      {children}
    </TransactionProvider>
  );
}

export default App;
