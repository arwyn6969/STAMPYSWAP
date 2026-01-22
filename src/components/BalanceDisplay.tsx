import { useState, useEffect } from 'react';
import { getBalances, type Balance } from '../lib/counterparty';

interface BalanceDisplayProps {
  userAddress: string;
}

export function BalanceDisplay({ userAddress }: BalanceDisplayProps) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userAddress) {
      setBalances([]);
      return;
    }

    const fetchBalances = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getBalances(userAddress);
        // Sort by quantity (highest first), limit to top 20
        const sorted = data
          .filter(b => b.quantity > 0)
          .sort((a, b) => b.quantity - a.quantity)
          .slice(0, 20);
        setBalances(sorted);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load balances');
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, [userAddress]);

  if (!userAddress) {
    return (
      <div className="card">
        <h2>Your Balances</h2>
        <div className="empty-state">
          <div className="empty-state-icon">👛</div>
          <div className="empty-state-title">No Wallet Connected</div>
          <div className="empty-state-text">Connect your wallet to see your balances</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-2">
        <h2>Your Balances</h2>
        <span className="badge truncate" style={{ maxWidth: '100px' }}>
          {userAddress.slice(0, 6)}...{userAddress.slice(-4)}
        </span>
      </div>

      {loading && (
        <div className="loading-state">
          <span className="spinner"></span>
          <span className="text-muted">Loading balances...</span>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
        </div>
      )}

      {!loading && !error && balances.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <div className="empty-state-title">No Assets Found</div>
          <div className="empty-state-text">This address has no Counterparty assets</div>
        </div>
      )}

      {!loading && !error && balances.length > 0 && (
        <div className="balance-list">
          {balances.map((balance) => {
            const qty = balance.quantity_normalized 
              ? parseFloat(balance.quantity_normalized)
              : balance.quantity / 100000000;
            
            return (
              <div key={balance.asset} className="balance-item">
                <span className="balance-asset truncate">{balance.asset}</span>
                <span className="balance-amount">
                  {qty.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                </span>
              </div>
            );
          })}
          {balances.length === 20 && (
            <p className="text-muted text-center" style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
              Showing top 20 assets
            </p>
          )}
        </div>
      )}
    </div>
  );
}
