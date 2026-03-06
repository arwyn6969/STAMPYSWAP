import { useState, useEffect } from 'react';
import { 
  detectAllWallets,
  connectWallet, 
  connectManual,
  disconnect,
  restoreStoredConnection,
  type WalletConnection, 
  type WalletProvider 
} from '../lib/wallet';

interface WalletConnectProps {
  onConnect: (address: string, canSign: boolean) => void;
  onDisconnect: () => void;
  connectedAddress: string;
}

export function WalletConnect({ onConnect, onDisconnect, connectedAddress }: WalletConnectProps) {
  const [availableWallets, setAvailableWallets] = useState<WalletProvider[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualAddress, setManualAddress] = useState('');

  // Detect wallets and restore session on mount
  useEffect(() => {
    const wallets = detectAllWallets();
    setAvailableWallets(wallets);

    const restored = restoreStoredConnection();
    if (restored) {
      setConnection(restored);
      if (!connectedAddress) {
        onConnect(restored.paymentAddress, restored.walletType !== 'manual');
      }
    }
  }, [connectedAddress, onConnect]);

  const handleConnect = async (walletType?: WalletProvider) => {
    setConnecting(true);
    setError(null);
    setShowWalletMenu(false);
    
    try {
      const conn = await connectWallet(walletType);
      setConnection(conn);
      onConnect(conn.paymentAddress, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setConnection(null);
    setShowWalletMenu(false);
    onDisconnect();
  };

  const handleManualEntryClick = () => {
    setShowManualInput(true);
    setShowWalletMenu(false);
  };

  const confirmManualEntry = () => {
    if (!manualAddress || !manualAddress.trim()) return;
    try {
      const conn = connectManual(manualAddress.trim());
      setConnection(conn);
      onConnect(conn.paymentAddress, false);
      setShowManualInput(false);
      setManualAddress('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid address');
    }
  };

  // If already connected
  if (connectedAddress) {
    const isWalletConnected = connection?.walletType && connection.walletType !== 'manual';
    
    return (
      <div className="wallet-connected-state">
        <span className="badge wallet-badge">
          {isWalletConnected ? (
            <>
              <span className="wallet-icon">
                {connection?.walletType === 'leather' ? '🔷' : 
                 connection?.walletType === 'xverse' ? '🟣' : '💼'}
              </span>
              <span className="truncate wallet-connected-address">
                {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
              </span>
            </>
          ) : (
            <>
              <span className="wallet-icon">👁️</span>
              <span className="truncate wallet-connected-address">
                {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
              </span>
              <span className="wallet-watch-label text-warning">
                Watch
              </span>
            </>
          )}
        </span>
        <button className="btn-secondary" type="button" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  // Not connected - show connect options
  return (
    <div className="wallet-connect">
      {error && (
        <span className="wallet-connect-error text-error">
          {error}
        </span>
      )}
      
      {showManualInput && (
        <div className="app-overlay" onClick={() => setShowManualInput(false)}>
          <div className="app-modal wallet-connect-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Enter Address</h3>
                <p className="modal-subtitle">Connect in watch-only mode and sign through the QR workflow.</p>
              </div>
              <button className="btn-icon drawer-close-btn" type="button" onClick={() => setShowManualInput(false)}>✕</button>
            </div>
            <input 
              type="text" 
              className="form-control" 
              autoFocus
              placeholder="bc1q..." 
              value={manualAddress}
              onChange={e => setManualAddress(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmManualEntry();
                if (e.key === 'Escape') setShowManualInput(false);
              }}
            />
            <div className="wallet-connect-modal-actions">
              <button className="btn-secondary" type="button" onClick={() => setShowManualInput(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={confirmManualEntry}>Connect</button>
            </div>
          </div>
        </div>
      )}

      {availableWallets.length === 1 && (
        <button 
          className="btn-primary" 
          type="button"
          onClick={() => handleConnect(availableWallets[0])}
          disabled={connecting}
        >
          {connecting ? (
            <span className="flex items-center gap-1">
              <span className="spinner"></span> Connecting...
            </span>
          ) : (
            <>
              {availableWallets[0] === 'leather' && '🔷 '}
              {availableWallets[0] === 'xverse' && '🟣 '}
              Connect {availableWallets[0].charAt(0).toUpperCase() + availableWallets[0].slice(1)}
            </>
          )}
        </button>
      )}

      {/* Multiple wallets - show dropdown */}
      {availableWallets.length > 1 && (
        <div className="wallet-dropdown">
          <button 
            className="btn-primary" 
            type="button"
            onClick={() => setShowWalletMenu(!showWalletMenu)}
            disabled={connecting}
          >
            {connecting ? (
              <span className="flex items-center gap-1">
                <span className="spinner"></span> Connecting...
              </span>
            ) : (
              'Connect Wallet ▼'
            )}
          </button>
          
          {showWalletMenu && (
            <div className="wallet-menu">
              {availableWallets.map(wallet => (
                <button 
                  key={wallet}
                  className="wallet-menu-item"
                  type="button"
                  onClick={() => handleConnect(wallet)}
                >
                  {wallet === 'leather' && '🔷 '}
                  {wallet === 'xverse' && '🟣 '}
                  {wallet.charAt(0).toUpperCase() + wallet.slice(1)}
                </button>
              ))}
              <div className="wallet-menu-divider"></div>
              <button 
                className="wallet-menu-item text-muted"
                type="button"
                onClick={handleManualEntryClick}
              >
                👁️ Watch Address
              </button>
            </div>
          )}
        </div>
      )}

      {availableWallets.length === 0 && (
        <div className="wallet-connect-watchonly">
          <button className="btn-primary" type="button" onClick={handleManualEntryClick}>
            Connect Wallet
          </button>
          <span className="wallet-watch-note text-muted">
            Watch-only
          </span>
        </div>
      )}
    </div>
  );
}
