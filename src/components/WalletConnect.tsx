import { useState, useEffect } from 'react';
import { 
  detectAllWallets,
  connectWallet, 
  connectManual,
  disconnect,
  getStoredConnection,
  getCurrentConnection,
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
    
    // Try to restore previous connection
    const stored = getStoredConnection();
    if (stored && !connectedAddress) {
      // We have a stored address but app doesn't know about it
      // Re-notify the app
      onConnect(stored.address, stored.walletType !== 'manual');
    }
    
    // Check if we have a live connection
    const current = getCurrentConnection();
    if (current) {
      setConnection(current);
    }
  }, []);

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
    setTimeout(() => {
        const input = document.querySelector('.modal-overlay input') as HTMLInputElement;
        if(input) input.focus();
    }, 100);
  };

  const confirmManualEntry = () => {
    if (manualAddress && manualAddress.trim()) {
      const conn = connectManual(manualAddress.trim());
      setConnection(conn);
      onConnect(conn.paymentAddress, false);
      setShowManualInput(false);
      setManualAddress('');
    }
  };

  // If already connected
  if (connectedAddress) {
    const isWalletConnected = connection?.walletType && connection.walletType !== 'manual';
    
    return (
      <div className="flex items-center gap-1">
        <span className="badge wallet-badge">
          {isWalletConnected ? (
            <>
              <span className="wallet-icon">
                {connection?.walletType === 'leather' ? '🔷' : 
                 connection?.walletType === 'xverse' ? '🟣' : '💼'}
              </span>
              <span className="truncate" style={{ maxWidth: '80px' }}>
                {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
              </span>
            </>
          ) : (
            <>
              <span className="wallet-icon">👁️</span>
              <span className="truncate" style={{ maxWidth: '80px' }}>
                {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
              </span>
              <span className="text-warning" style={{ fontSize: '0.5rem' }}>
                (watch)
              </span>
            </>
          )}
        </span>
        <button className="btn-secondary" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  // Not connected - show connect options
  return (
    <div className="wallet-connect" style={{ position: 'relative' }}>
      {error && (
        <span className="text-error" style={{ fontSize: '0.75rem', marginRight: '0.5rem' }}>
          {error}
        </span>
      )}
      
      {/* Manual Entry Modal */}
      {showManualInput && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setShowManualInput(false)}>
          <div className="card" onClick={e => e.stopPropagation()} style={{ minWidth: '320px' }}>
            <h3>Enter Address</h3>
            <p className="text-muted" style={{ fontSize: '0.9em' }}>Watch-only mode (signing required via Freewallet)</p>
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
              style={{ width: '100%', margin: '1rem 0' }}
            />
            <div className="flex gap-1 justify-end">
              <button className="btn-secondary" onClick={() => setShowManualInput(false)}>Cancel</button>
              <button className="btn-primary" onClick={confirmManualEntry}>Connect</button>
            </div>
          </div>
        </div>
      )}

      {/* Single wallet detected - show direct connect */}
      {availableWallets.length === 1 && (
        <button 
          className="btn-primary" 
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
                onClick={handleManualEntryClick}
              >
                👁️ Watch Address
              </button>
            </div>
          )}
        </div>
      )}

      {/* No wallets detected - show manual entry */}
      {availableWallets.length === 0 && (
        <div className="flex items-center gap-1">
          <button className="btn-primary" onClick={handleManualEntryClick}>
            Connect Wallet
          </button>
          <span className="text-muted" style={{ fontSize: '0.625rem' }}>
            (Watch-only)
          </span>
        </div>
      )}
    </div>
  );
}
