import { useState, useEffect, useCallback } from 'react';
import { getAssetDivisibility, getBalances, type Balance } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { baseUnitsToNumber } from '../lib/quantity';

interface PortfolioGridProps {
  userAddress: string;
  selectedAssets: string[];
  onToggleAsset: (asset: string) => void;
  onClearSelection: () => void;
  onProceedToCart?: () => void;
}

export function PortfolioGrid({ 
  userAddress, 
  selectedAssets, 
  onToggleAsset, 
  onClearSelection, 
  onProceedToCart 
}: PortfolioGridProps) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [divisibility, setDivisibility] = useState<Record<string, boolean>>({});

  const sortValue = useCallback((balance: Balance): number | null => {
    const normalized = balance.quantity_normalized;
    if (typeof normalized === 'string' && normalized.trim() !== '') {
      const parsed = Number.parseFloat(normalized);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }, []);

  const compareBalances = useCallback((a: Balance, b: Balance): number => {
    const aValue = sortValue(a);
    const bValue = sortValue(b);
    if (aValue !== null && bValue !== null) {
      return bValue - aValue;
    }
    if (aValue !== null) return -1;
    if (bValue !== null) return 1;
    if (a.quantity === b.quantity) return 0;
    return a.quantity > b.quantity ? -1 : 1;
  }, [sortValue]);

  useEffect(() => {
    if (!userAddress) {
      setBalances([]);
      return;
    }

    let cancelled = false;
    const fetchBalances = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getBalances(userAddress);
        // Sort by quantity (highest first), limit to top 40 for grid
        const sorted = data
          .filter(b => b.quantity > 0n)
          .sort(compareBalances)
          .slice(0, 40);
        if (cancelled) return;
        setBalances(sorted);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load balances');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchBalances().catch(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [userAddress, compareBalances]);

  useEffect(() => {
    let cancelled = false;
    const unresolvedAssets = balances
      .map((balance) => balance.asset)
      .filter((asset) => divisibility[asset] === undefined)
      .filter((asset) => !balances.find((balance) => balance.asset === asset && balance.quantity_normalized))
      .filter((asset, index, list) => list.indexOf(asset) === index);
    if (unresolvedAssets.length === 0) return undefined;

    const load = async () => {
      const entries = await Promise.all(
        unresolvedAssets.map(async (asset) => [asset, await getAssetDivisibility(asset)] as const),
      );
      if (cancelled) return;
      setDivisibility((prev) => {
        const next = { ...prev };
        for (const [asset, divisible] of entries) {
          next[asset] = divisible;
        }
        return next;
      });
    };

    load().catch(() => {
      // Use default fallback for unresolved assets.
    });

    return () => {
      cancelled = true;
    };
  }, [balances, divisibility]);

  if (!userAddress) {
    return null;
  }

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-2">
        <h2>Your Portfolio</h2>
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
        <>
          <div className="portfolio-grid">
            {balances.map((balance) => {
              const normalized = balance.quantity_normalized?.trim();
              const parsedNormalized = normalized ? Number.parseFloat(normalized) : Number.NaN;
              const qty = Number.isFinite(parsedNormalized)
                ? parsedNormalized
                : baseUnitsToNumber(balance.quantity, divisibility[balance.asset] ?? true);
              
              const isSelected = selectedAssets.includes(balance.asset);
              
              return (
                <div 
                  key={balance.asset} 
                  className={`portfolio-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => onToggleAsset(balance.asset)}
                  title={balance.asset}
                >
                  <AssetIcon asset={balance.asset} size={40} showStampNumber={false} />
                  <span className="portfolio-item-amount truncate" style={{ maxWidth: '100%' }}>
                    {qty >= 1000 ? qty.toLocaleString(undefined, { maximumFractionDigits: 0 }) : qty.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
          {selectedAssets.length > 0 && (
            <div className="mt-2 text-center flex flex-col gap-2 items-center" style={{ marginTop: '1rem' }}>
              <div className="flex gap-2">
                <button 
                  className="btn-primary flex items-center gap-1 font-bold" 
                  style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                  onClick={onProceedToCart}
                >
                  🛒 Review Cart ({selectedAssets.length})
                </button>
              </div>
              <button 
                className="btn-secondary" 
                style={{ fontSize: '0.625rem', padding: '0.25rem 0.5rem' }}
                onClick={onClearSelection}
              >
                Clear Selection
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
