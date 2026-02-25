import { useState, useEffect, useCallback, useRef } from 'react';
import { OpportunityMatcher, type TradeOpportunity } from '../lib/agent/OpportunityMatcher';
import { getBalances } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface OpportunityScannerProps {
  userAddress: string;
  onSelect: (opp: TradeOpportunity) => void;
}

export function OpportunityScanner({ userAddress, onSelect }: OpportunityScannerProps) {
  const [opportunities, setOpportunities] = useState<TradeOpportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRequestId = useRef(0);

  const scan = useCallback(async () => {
    if (!userAddress) return;
    const requestId = ++scanRequestId.current;
    setLoading(true);
    setSearched(true);
    setError(null);
    try {
      // 1. Get user balances
      const balances = await getBalances(userAddress);
      
      // 2. Find matches
      const matches = await OpportunityMatcher.findMatches(balances);
      if (requestId !== scanRequestId.current) return;
      setOpportunities(matches);
    } catch (e) {
      if (requestId !== scanRequestId.current) return;
      setError(e instanceof Error ? e.message : 'Failed to scan opportunities');
      setOpportunities([]);
    } finally {
      if (requestId === scanRequestId.current) {
        setLoading(false);
      }
    }
  }, [userAddress]);

  // Auto-scan on mount/address change? Maybe better not to spam API. 
  // Let's make it a button or auto-scan once.
  useEffect(() => {
    if (userAddress) {
      scan();
    }
  }, [userAddress, scan]);

  if (!userAddress) return null;

  if (loading) {
    return (
      <div className="card">
        <div className="loading-state" style={{ padding: '1rem' }}>
          <span className="spinner"></span>
          <div className="text-muted" style={{ fontSize: '0.875rem' }}>
            Scanning market for opportunities...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-title">Opportunity Scan Failed</div>
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" onClick={scan}>Retry</button>
        </div>
      </div>
    );
  }

  if (searched && opportunities.length === 0) {
    return null; // Don't show if nothing found, to reduce clutter
  }

  return (
    <div className="card" style={{ borderLeft: '4px solid var(--success)' }}>
      <div className="flex justify-between items-center mb-2">
        <h3 className="flex items-center gap-1" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          <span style={{ fontSize: '1.25rem' }}>💰</span> Active Buyers Found!
        </h3>
        <button className="btn-icon" onClick={scan} title="Rescan opportunities">
          ↻
        </button>
      </div>
      
      <div className="flex flex-col gap-1" style={{ maxHeight: '15rem', overflowY: 'auto' }}>
        {opportunities.map((opp) => (
          <div 
            key={opp.order.tx_hash}
            className="balance-item"
            style={{ cursor: 'pointer', border: '1px solid var(--border-color)' }}
            onClick={() => onSelect(opp)}
          >
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="badge text-success">SELL</span>
                <span style={{ fontWeight: 600 }}>
                    {opp.asset}
                </span>
                 <AssetIcon asset={opp.asset} size={16} />
              </div>
              <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                You have it
              </div>
            </div>
            
            <div className="mb-1 flex justify-between items-center" style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
              <div>
                <span className="text-muted">Get: </span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                  {opp.expectedReturn.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.getAsset}
                </span>
              </div>
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: '0.125rem 0.375rem',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                }}
              >
                Price: {opp.price.toFixed(6)}
              </div>
            </div>
            <div className="text-muted" style={{ fontSize: '0.75rem' }}>
              Sell {opp.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.asset}
            </div>
             <div className="text-muted truncate" style={{ fontSize: '0.625rem', marginTop: '0.25rem' }}>
               Tx: {opp.order.tx_hash}
             </div>
          </div>
        ))}
      </div>
    </div>
  );
}
