import { useState, useEffect } from 'react';
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

  const scan = async () => {
    if (!userAddress) return;
    setLoading(true);
    setSearched(true);
    try {
      // 1. Get user balances
      const balances = await getBalances(userAddress);
      
      // 2. Find matches
      const matches = await OpportunityMatcher.findMatches(balances);
      setOpportunities(matches);
    } catch (e) {
      console.error('Scan failed', e);
    } finally {
      setLoading(false);
    }
  };

  // Auto-scan on mount/address change? Maybe better not to spam API. 
  // Let's make it a button or auto-scan once.
  useEffect(() => {
    if (userAddress) {
      scan();
    }
  }, [userAddress]);

  if (!userAddress) return null;

  if (loading) {
    return (
      <div className="card animate-pulse">
        <div className="text-sm font-bold opacity-50">Scanning Market for Opportunities...</div>
      </div>
    );
  }

  if (searched && opportunities.length === 0) {
    return null; // Don't show if nothing found, to reduce clutter
  }

  return (
    <div className="card bg-base-200 border-l-4 border-success">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <span className="text-xl">💰</span> Active Buyers Found!
        </h3>
        <button className="btn-xs btn-ghost" onClick={scan}>↻</button>
      </div>
      
      <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
        {opportunities.map((opp) => (
          <div 
            key={opp.order.tx_hash}
            className="p-2 bg-base-100 rounded hover:bg-neutral cursor-pointer transition-colors border border-base-content/10"
            onClick={() => onSelect(opp)}
          >
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="badge badge-success btn-xs">SELL</span>
                <span className="font-bold">
                    {opp.asset}
                </span>
                 <AssetIcon asset={opp.asset} size={16} />
              </div>
              <div className="text-xs opacity-70">
                You have it
              </div>
            </div>
            
            <div className="mt-1 flex justify-between items-center text-sm">
              <div>
                <span className="opacity-70">Get: </span>
                <span className="font-mono font-bold">{opp.order.give_asset}</span>
              </div>
              <div className="font-mono bg-base-200 px-1 rounded">
                Price: {opp.price.toFixed(6)}
              </div>
            </div>
             <div className="text-[10px] opacity-50 mt-1 truncate">
               Tx: {opp.order.tx_hash}
             </div>
          </div>
        ))}
      </div>
    </div>
  );
}
