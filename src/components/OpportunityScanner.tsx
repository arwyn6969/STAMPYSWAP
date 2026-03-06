import { useState, useEffect, useCallback, useRef } from 'react';
import { OpportunityMatcher, type TradeOpportunity } from '../lib/agent/OpportunityMatcher';
import { getBalances } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface OpportunityScannerProps {
  userAddress: string;
  onSelect: (opp: TradeOpportunity) => void;
  assetFilter?: string | null;
}

export function OpportunityScanner({ userAddress, onSelect, assetFilter }: OpportunityScannerProps) {
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
      const matches = await OpportunityMatcher.findMatches(balances, undefined, assetFilter ?? undefined);
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
  }, [userAddress, assetFilter]);

  useEffect(() => {
    if (userAddress) {
      scan();
    }
  }, [userAddress, scan]);

  if (!userAddress) return null;

  if (loading) {
    return (
      <div className="card utility-card utility-card-sell">
        <div className="loading-state utility-loading-state">
          <span className="spinner"></span>
          <div className="text-muted utility-loading-copy">
            Scanning market for opportunities...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card utility-card utility-card-sell">
        <div className="empty-state">
          <div className="empty-state-title">Opportunity Scan Failed</div>
          <div className="empty-state-text text-error">{error}</div>
          <button className="btn-secondary" type="button" onClick={scan}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card utility-card utility-card-sell">
      <div className="utility-card-header">
        <div>
          <h3 className="utility-card-title">Sell Opportunities</h3>
          <p className="utility-card-subtitle">
            {assetFilter
              ? `Showing active buyers for ${assetFilter}.`
              : 'Scan the market for open orders you can fill with your current holdings.'}
          </p>
        </div>
        <button className="btn-icon" type="button" onClick={scan} title="Rescan opportunities">
          ↻
        </button>
      </div>

      {searched && opportunities.length === 0 && (
        <div className="empty-state utility-empty-state">
          <div className="empty-state-title">No active buyers found</div>
          <div className="empty-state-text">
            {assetFilter ? `No buyers matched ${assetFilter} right now.` : 'No portfolio assets matched an attractive open order right now.'}
          </div>
        </div>
      )}
      
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
                <span className="badge text-success">SELL</span>
                <AssetIcon asset={opp.asset} size={16} />
                <span className="utility-opportunity-symbol">{opp.asset}</span>
              </div>
              <div className="utility-opportunity-meta">
                You have it
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
              Sell {opp.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })} {opp.asset}
            </div>
            <div className="utility-opportunity-foot">
              <span className="text-muted truncate">Tx: {opp.order.tx_hash}</span>
              <span className="utility-opportunity-cta">Prefill order</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
