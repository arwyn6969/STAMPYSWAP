import { useState, useEffect, useCallback, useRef } from 'react';
import { OpportunityMatcher, type TradeOpportunity } from '../lib/agent/OpportunityMatcher';
import { getBalances } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface BuyOpportunityScannerProps {
  userAddress: string;
  wishlist: string[];
  onSelect: (opp: TradeOpportunity) => void;
  onAddToWishlist: (asset: string) => void;
  onRemoveFromWishlist: (asset: string) => void;
}

export function BuyOpportunityScanner({
  userAddress,
  wishlist,
  onSelect,
  onAddToWishlist,
  onRemoveFromWishlist,
}: BuyOpportunityScannerProps) {
  const [opportunities, setOpportunities] = useState<TradeOpportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addInput, setAddInput] = useState('');
  const scanRequestId = useRef(0);

  const scan = useCallback(async () => {
    if (!userAddress || wishlist.length === 0) {
      setOpportunities([]);
      setSearched(true);
      return;
    }
    const requestId = ++scanRequestId.current;
    setLoading(true);
    setSearched(true);
    setError(null);
    try {
      const balances = await getBalances(userAddress);
      const matches = await OpportunityMatcher.findBuyOpportunities(wishlist, balances);
      if (requestId !== scanRequestId.current) return;
      setOpportunities(matches);
    } catch (e) {
      if (requestId !== scanRequestId.current) return;
      setError(e instanceof Error ? e.message : 'Failed to scan buy opportunities');
      setOpportunities([]);
    } finally {
      if (requestId === scanRequestId.current) {
        setLoading(false);
      }
    }
  }, [userAddress, wishlist]);

  useEffect(() => {
    if (userAddress && wishlist.length > 0) {
      scan();
    } else {
      setOpportunities([]);
      setSearched(false);
    }
  }, [userAddress, wishlist, scan]);

  const handleAddSubmit = () => {
    const asset = addInput.trim().toUpperCase();
    if (asset) {
      onAddToWishlist(asset);
      setAddInput('');
    }
  };

  if (!userAddress) return null;

  return (
    <div className="card" style={{ borderLeft: '4px solid var(--accent-primary)' }}>
      <div className="flex justify-between items-center mb-2">
        <h3 className="flex items-center gap-1" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          <span style={{ fontSize: '1.25rem' }}>🛍️</span> Buy Opportunities
        </h3>
        {wishlist.length > 0 && (
          <button className="btn-icon" onClick={scan} title="Rescan buy opportunities">
            ↻
          </button>
        )}
      </div>

      {/* Wishlist chips */}
      <div className="wishlist-chips">
        {wishlist.map(asset => (
          <span key={asset} className="wishlist-chip">
            <AssetIcon asset={asset} size={12} showStampNumber={false} />
            {asset}
            <button
              className="wishlist-chip-remove"
              onClick={() => onRemoveFromWishlist(asset)}
              title={`Remove ${asset}`}
            >
              ✕
            </button>
          </span>
        ))}
        <span className="wishlist-add">
          <input
            type="text"
            placeholder="Asset name"
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddSubmit();
            }}
          />
          <button
            className="btn-primary"
            onClick={handleAddSubmit}
            disabled={!addInput.trim()}
          >
            +
          </button>
        </span>
      </div>

      {/* States */}
      {wishlist.length === 0 && (
        <div className="text-muted" style={{ fontSize: '0.8rem', textAlign: 'center', padding: '0.5rem' }}>
          Add assets you'd like to buy to scan for sellers
        </div>
      )}

      {loading && (
        <div className="loading-state" style={{ padding: '1rem' }}>
          <span className="spinner"></span>
          <div className="text-muted" style={{ fontSize: '0.875rem' }}>
            Scanning for sellers...
          </div>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" onClick={scan}>Retry</button>
        </div>
      )}

      {!loading && !error && searched && wishlist.length > 0 && opportunities.length === 0 && (
        <div className="text-muted" style={{ fontSize: '0.8rem', textAlign: 'center', padding: '0.5rem' }}>
          No sellers found for your wishlist assets
        </div>
      )}

      {!loading && !error && opportunities.length > 0 && (
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
                  <span className="badge" style={{ background: 'rgba(99, 102, 241, 0.2)', color: 'var(--accent-primary)' }}>
                    BUY
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {opp.getAsset}
                  </span>
                  <AssetIcon asset={opp.getAsset} size={16} />
                </div>
                <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                  Available
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
                Pay {opp.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.asset}
              </div>
              <div className="text-muted truncate" style={{ fontSize: '0.625rem', marginTop: '0.25rem' }}>
                Tx: {opp.order.tx_hash}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
