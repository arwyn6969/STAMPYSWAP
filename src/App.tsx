import { useCallback, useEffect, useState } from 'react';
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
  const initialCompactViewport = typeof window !== 'undefined'
    ? window.matchMedia('(max-width: 768px)').matches
    : false;
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<'sell' | 'buy' | 'history'>('sell');
  const [isCompactViewport, setIsCompactViewport] = useState(initialCompactViewport);
  const [isDepthExpanded, setIsDepthExpanded] = useState(!initialCompactViewport);
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
    macroError, clearMacroError,
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

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const syncViewport = (event?: MediaQueryListEvent) => {
      const matches = event?.matches ?? mediaQuery.matches;
      setIsCompactViewport(matches);
      setIsDepthExpanded(!matches);
    };

    syncViewport();
    mediaQuery.addEventListener('change', syncViewport);
    return () => mediaQuery.removeEventListener('change', syncViewport);
  }, []);

  const askCount = orders.filter((order) => order.status === 'open' && order.give_asset === asset1).length;
  const bidCount = orders.filter((order) => order.status === 'open' && order.get_asset === asset1).length;
  const canCollapseDepth = isCompactViewport && !loading && !error && orders.length > 0;

  const activeUtilityMeta = {
    sell: {
      title: 'Sell-side Tools',
      subtitle: selectedPortfolioAssets.length === 1
        ? `Scanning for active buyers of ${selectedPortfolioAssets[0]}.`
        : 'Scan your current holdings for orders you can fill immediately.',
      badge: selectedPortfolioAssets.length === 1 ? `Focused on ${selectedPortfolioAssets[0]}` : 'Uses portfolio selection',
    },
    buy: {
      title: 'Buy Watchlist',
      subtitle: 'Track wanted assets, compare seller offers, and prefill a buy order from the results.',
      badge: `${buyWishlist.length} watched`,
    },
    history: {
      title: 'Order History',
      subtitle: 'Review recent orders, filter by status, and jump back into a traded market.',
      badge: userAddress ? 'Account activity' : 'Connect a wallet',
    },
  } as const;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand-block">
          <div>
            <h1>STAMPYSWAP</h1>
            <p className="text-muted">Counterparty DEX Interface</p>
          </div>
          <div className="app-status-strip">
            <span className={`status-pill ${userAddress ? 'is-live' : ''}`}>
              {userAddress ? 'Wallet connected' : 'Connect a wallet to trade'}
            </span>
            <span className={`status-pill ${walletCanSign ? 'is-live' : ''}`}>
              {walletCanSign ? 'Direct signing ready' : 'QR signing flow'}
            </span>
            {pendingCount > 0 && (
              <span className="status-pill is-live">
                {pendingCount} pending tx{pendingCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {userAddress && !walletCanSign && (
            <p className="connection-hint text-warning">
              Watch-only mode detected. Compose orders here and sign them from the QR flow.
            </p>
          )}
        </div>
        <div className="app-header-actions">
          <button 
            className="btn-secondary flex items-center gap-1 tx-center-trigger"
            onClick={openDrawer}
          >
            📋 Tx Center
            {pendingCount > 0 && (
              <span className="badge badge-primary tx-center-count">
                {pendingCount}
              </span>
            )}
          </button>
          
          <div className="network-toggle">
            <label className="network-toggle-label">
              Testnet
              <input 
                type="checkbox" 
                checked={getIsTestnet()} 
                onChange={(e) => {
                  setTestnet(e.target.checked);
                  window.location.reload();
                }}
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

      {asset1 && asset2 && (
        <>
        <div className="workspace-toolbar">
          <div className="workspace-copy">
            <span className="workspace-kicker">Primary workflow</span>
            <span className="workspace-title">{asset1}/{asset2}</span>
            <span className="workspace-subtitle">Choose a market, shape the order, then verify the transaction.</span>
          </div>
          <div className="workspace-toolbar-actions">
            {lastRefresh && (
              <span className="workspace-refresh-label">
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button 
              className="btn-icon" 
              onClick={() => void fetchOrders(true)}
              disabled={loading}
              title="Refresh orders"
            >
              {loading ? <span className="spinner"></span> : '↻'}
            </button>
          </div>
        </div>
        <div className="workspace-overview">
          <div className="workspace-overview-card is-emphasis">
            <span className="workspace-overview-step">1</span>
            <div>
              <div className="workspace-overview-title">Set the market</div>
              <div className="workspace-overview-copy">You are trading <strong>{asset1}</strong> against <strong>{asset2}</strong>.</div>
            </div>
          </div>
          <div className="workspace-overview-card">
            <span className="workspace-overview-step">2</span>
            <div>
              <div className="workspace-overview-title">Choose an action</div>
              <div className="workspace-overview-copy">
                {selectedPortfolioAssets.length > 0
                  ? `${selectedPortfolioAssets.length} portfolio asset${selectedPortfolioAssets.length === 1 ? '' : 's'} selected for focused actions.`
                  : 'Use the portfolio selector or order book to prefill your next order.'}
              </div>
            </div>
          </div>
          <div className="workspace-overview-card">
            <span className="workspace-overview-step">3</span>
            <div>
              <div className="workspace-overview-title">Sign and track</div>
              <div className="workspace-overview-copy">
                {walletCanSign
                  ? 'Direct wallet signing is available when you are ready to review the transaction.'
                  : 'Orders will move into the QR signer and transaction center for manual approval.'}
              </div>
            </div>
          </div>
        </div>
        </>
      )}

      {macroError && (
        <div className="form-feedback form-feedback-error batch-status-banner" role="alert">
          <div className="batch-status-copy">
            <p className="form-feedback-title">Batch listing stopped</p>
            <p className="form-feedback-copy">{macroError}</p>
          </div>
          <div className="batch-status-actions">
            {selectedPortfolioAssets.length > 0 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={openCart}
              >
                Review Batch Plan
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={clearMacroError}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="workspace-shell">
        <div className="workspace-main">
          <div className="trade-workspace-grid">
            <TradeForm 
              userAddress={userAddress} 
              onOrderComposed={setComposeResult}
              giveAssetDefault={asset1}
              getAssetDefault={asset2}
              prefill={prefillOrder}
              orders={orders}
            />
            <OrderBook 
              orders={orders} 
              asset1={asset1} 
              asset2={asset2} 
              loading={loading} 
              error={error}
              onOrderClick={handleOrderSweep} 
              onOrderCompete={handleOrderCompete}
            />
          </div>

          <div className="card market-depth-card">
            <div className="workspace-card-header">
              <div>
                <h2 className="mb-1">Market Depth</h2>
                <p className="workspace-card-subtitle">
                  {canCollapseDepth
                    ? 'Collapsed by default on smaller screens so the trading path stays focused.'
                    : 'Use this as context, not the first stop.'}
                </p>
              </div>
              {canCollapseDepth && (
                <button
                  type="button"
                  className="btn-secondary market-depth-toggle"
                  aria-expanded={isDepthExpanded}
                  onClick={() => setIsDepthExpanded((current) => !current)}
                >
                  {isDepthExpanded ? 'Hide Chart' : 'Show Chart'}
                </button>
              )}
            </div>
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
                <button className="btn-secondary" onClick={() => void fetchOrders(true)}>Try Again</button>
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
            {canCollapseDepth && !isDepthExpanded && (
              <div className="market-depth-collapsed">
                <div className="market-depth-collapsed-stat">
                  <span className="market-depth-collapsed-label">Bids</span>
                  <span className="market-depth-collapsed-value text-success">{bidCount}</span>
                </div>
                <div className="market-depth-collapsed-stat">
                  <span className="market-depth-collapsed-label">Asks</span>
                  <span className="market-depth-collapsed-value text-error">{askCount}</span>
                </div>
                <div className="market-depth-collapsed-copy">
                  Open the chart when you want a fuller view of ladder depth and spread positioning.
                </div>
              </div>
            )}
            {!loading && !error && orders.length > 0 && (!canCollapseDepth || isDepthExpanded) && (
              <DepthChart orders={orders} asset1={asset1} asset2={asset2} />
            )}
          </div>
        </div>

        <div className="workspace-sidebar">
          <PortfolioGrid 
            userAddress={userAddress} 
            selectedAssets={selectedPortfolioAssets}
            onToggleAsset={handleTogglePortfolioAsset}
            onClearSelection={clearPortfolioSelection}
            onProceedToCart={openCart}
          />

          {userAddress && (
            <div className="card utility-hub-card">
              <div className="workspace-card-header">
                <div>
                  <h2>{activeUtilityMeta[activeUtilityPanel].title}</h2>
                  <p className="workspace-card-subtitle">{activeUtilityMeta[activeUtilityPanel].subtitle}</p>
                </div>
                <span className="badge">{activeUtilityMeta[activeUtilityPanel].badge}</span>
              </div>
              <div className="utility-panel-switcher">
                <button
                  type="button"
                  className={`intent-chip ${activeUtilityPanel === 'sell' ? 'active' : ''}`}
                  aria-pressed={activeUtilityPanel === 'sell'}
                  onClick={() => setActiveUtilityPanel('sell')}
                >
                  Sell Matches
                </button>
                <button
                  type="button"
                  className={`intent-chip ${activeUtilityPanel === 'buy' ? 'active' : ''}`}
                  aria-pressed={activeUtilityPanel === 'buy'}
                  onClick={() => setActiveUtilityPanel('buy')}
                >
                  Buy Watchlist
                </button>
                <button
                  type="button"
                  className={`intent-chip ${activeUtilityPanel === 'history' ? 'active' : ''}`}
                  aria-pressed={activeUtilityPanel === 'history'}
                  onClick={() => setActiveUtilityPanel('history')}
                >
                  Order History
                </button>
              </div>
            </div>
          )}

          {activeUtilityPanel === 'sell' && (
            <OpportunityScanner 
              userAddress={userAddress} 
              onSelect={handleOpportunitySelect}
              assetFilter={selectedPortfolioAssets.length === 1 ? selectedPortfolioAssets[0] : null}
            />
          )}
          {activeUtilityPanel === 'buy' && (
            <BuyOpportunityScanner
              userAddress={userAddress}
              wishlist={buyWishlist}
              onSelect={handleOpportunitySelect}
              onAddToWishlist={addToWishlist}
              onRemoveFromWishlist={removeFromWishlist}
            />
          )}
          {activeUtilityPanel === 'history' && (
            <OrderHistory
              userAddress={userAddress}
              onViewPair={handlePairChange}
            />
          )}
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
        macroError={macroError}
        onClearMacroError={clearMacroError}
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
    void market.fetchOrders(true);
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
