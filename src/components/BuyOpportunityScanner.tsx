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
    <div className="card utility-card utility-card-buy">
      <div className="utility-card-header">
        <div>
          <h3 className="utility-card-title">Buy Watchlist</h3>
          <p className="utility-card-subtitle">
            Keep a shortlist of target assets and surface sellers you can prefill against.
          </p>
        </div>
        {wishlist.length > 0 && (
          <button className="btn-icon" type="button" onClick={scan} title="Rescan buy opportunities">
            ↻
          </button>
        )}
      </div>

      <div className="wishlist-editor">
        <div className="wishlist-editor-copy">
          <span className="wishlist-editor-title">Wanted assets</span>
          <span className="wishlist-editor-note">Add symbols you want to accumulate.</span>
        </div>
      </div>

      <div className="wishlist-chips">
        {wishlist.map(asset => (
          <span key={asset} className="wishlist-chip">
            <AssetIcon asset={asset} size={12} showStampNumber={false} />
            {asset}
            <button
              className="wishlist-chip-remove"
              type="button"
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
            type="button"
            onClick={handleAddSubmit}
            disabled={!addInput.trim()}
          >
            +
          </button>
        </span>
      </div>

      {wishlist.length === 0 && (
        <div className="utility-inline-empty text-muted">
          Add assets you'd like to buy to scan for sellers
        </div>
      )}

      {loading && (
        <div className="loading-state utility-loading-state">
          <span className="spinner"></span>
          <div className="text-muted utility-loading-copy">
            Scanning for sellers...
          </div>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" type="button" onClick={scan}>Retry</button>
        </div>
      )}

      {!loading && !error && searched && wishlist.length > 0 && opportunities.length === 0 && (
        <div className="utility-inline-empty text-muted">
          No sellers found for your wishlist assets
        </div>
      )}

      {!loading && !error && opportunities.length > 0 && (
        <div className="utility-list">
          {opportunities.map((opp) => (
            <button
              type="button"
              key={opp.order.tx_hash}
              className="utility-opportunity"
              onClick={() => onSelect(opp)}
            >
              <div className="utility-opportunity-top">
                <div className="utility-opportunity-asset">
                  <span className="badge badge-primary">
                    BUY
                  </span>
                  <AssetIcon asset={opp.getAsset} size={16} />
                  <span className="utility-opportunity-symbol">{opp.getAsset}</span>
                </div>
                <div className="utility-opportunity-meta">
                  Available
                </div>
              </div>

              <div className="utility-opportunity-middle">
                <div>
                  <span className="text-muted">Get: </span>
                  <span className="utility-opportunity-value">
                    {opp.expectedReturn.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.getAsset}
                  </span>
                </div>
                <div className="utility-opportunity-price">
                  Price: {opp.price.toFixed(6)}
                </div>
              </div>
              <div className="utility-opportunity-copy text-muted">
                Pay {opp.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.asset}
              </div>
              <div className="utility-opportunity-foot">
                <span className="text-muted truncate">Tx: {opp.order.tx_hash}</span>
                <span className="utility-opportunity-cta">Prefill order</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
