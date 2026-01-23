import { useState, useEffect } from 'react';
import { detectWallet, connectWallet, type WalletConnection, type WalletProvider } from '../lib/wallet';

interface WalletConnectProps {
  onConnect: (address: string) => void;
  onDisconnect: () => void;
  connectedAddress: string;
}

export function WalletConnect({ onConnect, onDisconnect, connectedAddress }: WalletConnectProps) {
  const [walletType, setWalletType] = useState<WalletProvider | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);

  // Detect wallet on mount
  useEffect(() => {
    const detected = detectWallet();
    setWalletType(detected);
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    
    try {
      const conn = await connectWallet();
      setConnection(conn);
      onConnect(conn.paymentAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setConnection(null);
    onDisconnect();
  };

  const handleManualEntry = () => {
    const address = prompt('Enter your Bitcoin address:');
    if (address) {
      onConnect(address);
    }
  };

  // If already connected
  if (connectedAddress) {
    return (
      <div className="flex items-center gap-1">
        <span className="badge wallet-badge">
          {connection ? (
            <>
              <span className="wallet-icon">
                {walletType === 'leather' ? '🔷' : walletType === 'xverse' ? '🟣' : '💼'}
              </span>
              <span className="truncate" style={{ maxWidth: '80px' }}>
                {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
              </span>
            </>
          ) : (
            <span className="truncate" style={{ maxWidth: '100px' }}>
              {connectedAddress.slice(0, 8)}...{connectedAddress.slice(-6)}
            </span>
          )}
        </span>
        <button className="btn-secondary" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  // Not connected
  return (
    <div className="wallet-connect">
      {error && (
        <span className="text-error" style={{ fontSize: '0.75rem', marginRight: '0.5rem' }}>
          {error}
        </span>
      )}
      
      {walletType ? (
        <button 
          className="btn-primary" 
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting ? (
            <span className="flex items-center gap-1">
              <span className="spinner"></span> Connecting...
            </span>
          ) : (
            <>
              {walletType === 'leather' && '🔷 '}
              {walletType === 'xverse' && '🟣 '}
              Connect {walletType.charAt(0).toUpperCase() + walletType.slice(1)}
            </>
          )}
        </button>
      ) : (
        <div className="flex items-center gap-1">
          <button className="btn-primary" onClick={handleManualEntry}>
            Connect Wallet
          </button>
          <span className="text-muted" style={{ fontSize: '0.625rem' }}>
            (No wallet detected)
          </span>
        </div>
      )}
    </div>
  );
}
