import { useState, useEffect, useCallback } from 'react';
import { getAssetDivisibility, getBalances, type Balance } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { baseUnitsToNumber } from '../lib/quantity';
import { isNumericAsset } from '../lib/stamps';

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
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<'quantity' | 'alpha'>('quantity');
  const [filterMode, setFilterMode] = useState<'all' | 'stamps' | 'selected'>('all');

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
        if (cancelled) return;
        setBalances(data.filter(b => b.quantity > 0n));
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

  const stampCount = balances.filter((balance) => isNumericAsset(balance.asset)).length;
  const normalizedSearch = search.trim().toUpperCase();
  const filteredBalances = balances
    .filter((balance) => {
      if (filterMode === 'stamps' && !isNumericAsset(balance.asset)) return false;
      if (filterMode === 'selected' && !selectedAssets.includes(balance.asset)) return false;
      if (normalizedSearch && !balance.asset.includes(normalizedSearch)) return false;
      return true;
    })
    .sort((left, right) => {
      if (sortMode === 'alpha') {
        return left.asset.localeCompare(right.asset);
      }
      return compareBalances(left, right);
    })
    .slice(0, 60);
  const selectedLabel = selectedAssets.length === 0
    ? 'Select one or more assets to focus the workspace.'
    : selectedAssets.length === 1
      ? `${selectedAssets[0]} is selected. Sell-side scanning is now focused on that asset.`
      : `${selectedAssets.length} assets selected. Batch listing will build one order per asset.`;

  return (
    <div className="card portfolio-card">
      <div className="portfolio-header">
        <div>
          <h2>Your Portfolio</h2>
          <p className="portfolio-subtitle">
            Select holdings to build a batch listing plan or scan for active buyers.
          </p>
        </div>
        <span className="badge truncate" style={{ maxWidth: '120px' }}>
          {userAddress.slice(0, 6)}...{userAddress.slice(-4)}
        </span>
      </div>

      <div className="portfolio-stats">
        <div className="portfolio-stat">
          <span className="portfolio-stat-label">Holdings</span>
          <span className="portfolio-stat-value">{balances.length}</span>
        </div>
        <div className="portfolio-stat">
          <span className="portfolio-stat-label">Stamps</span>
          <span className="portfolio-stat-value">{stampCount}</span>
        </div>
        <div className="portfolio-stat">
          <span className="portfolio-stat-label">Selected</span>
          <span className="portfolio-stat-value">{selectedAssets.length}</span>
        </div>
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
          <div className="portfolio-toolbar">
            <input
              type="text"
              placeholder="Search asset or collection"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value as 'quantity' | 'alpha')}>
              <option value="quantity">Sort by quantity</option>
              <option value="alpha">Sort A-Z</option>
            </select>
          </div>
          <div className="portfolio-filter-row">
            <button
              type="button"
              className={`intent-chip ${filterMode === 'all' ? 'active' : ''}`}
              aria-pressed={filterMode === 'all'}
              onClick={() => setFilterMode('all')}
            >
              All ({balances.length})
            </button>
            <button
              type="button"
              className={`intent-chip ${filterMode === 'stamps' ? 'active' : ''}`}
              aria-pressed={filterMode === 'stamps'}
              onClick={() => setFilterMode('stamps')}
            >
              Stamps ({stampCount})
            </button>
            <button
              type="button"
              className={`intent-chip ${filterMode === 'selected' ? 'active' : ''}`}
              aria-pressed={filterMode === 'selected'}
              onClick={() => setFilterMode('selected')}
            >
              Selected ({selectedAssets.length})
            </button>
          </div>

          <div className="portfolio-selection-banner">
            <div>
              <div className="portfolio-selection-title">Selection focus</div>
              <div className="portfolio-selection-copy">{selectedLabel}</div>
            </div>
            {selectedAssets.length > 0 && (
              <div className="portfolio-selection-chips">
                {selectedAssets.slice(0, 4).map((asset) => (
                  <span key={asset} className="portfolio-selection-chip">
                    <AssetIcon asset={asset} size={14} showStampNumber={false} />
                    {asset}
                  </span>
                ))}
                {selectedAssets.length > 4 && (
                  <span className="portfolio-selection-chip">+{selectedAssets.length - 4} more</span>
                )}
              </div>
            )}
          </div>

          {filteredBalances.length === 0 && (
            <div className="empty-state" style={{ paddingTop: '1rem' }}>
              <div className="empty-state-text">
                No assets match the current search/filter.
              </div>
            </div>
          )}

          <div className="portfolio-grid">
            {filteredBalances.map((balance) => {
              const normalized = balance.quantity_normalized?.trim();
              const parsedNormalized = normalized ? Number.parseFloat(normalized) : Number.NaN;
              const qty = Number.isFinite(parsedNormalized)
                ? parsedNormalized
                : baseUnitsToNumber(balance.quantity, divisibility[balance.asset] ?? true);
              
              const isSelected = selectedAssets.includes(balance.asset);
              
              return (
                <button 
                  key={balance.asset} 
                  className={`portfolio-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => onToggleAsset(balance.asset)}
                  title={balance.asset}
                  type="button"
                >
                  <div className="portfolio-item-top">
                    <AssetIcon asset={balance.asset} size={32} showStampNumber={false} />
                    <div className="portfolio-item-copy">
                      <span className="portfolio-item-asset">{balance.asset}</span>
                      <span className="portfolio-item-amount">
                        {qty >= 1000 ? qty.toLocaleString(undefined, { maximumFractionDigits: 0 }) : qty.toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <span className="portfolio-item-state">
                    {isSelected ? 'Selected for batch listing' : 'Tap to add'}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="portfolio-action-bar">
            <div>
              <div className="portfolio-action-count">{selectedAssets.length} asset{selectedAssets.length === 1 ? '' : 's'} selected</div>
              <div className="portfolio-action-text">
                Use the selector to build a batch listing plan or narrow the sell scanner.
              </div>
            </div>
            <div className="portfolio-action-buttons">
              <button 
                className="btn-primary"
                type="button"
                onClick={onProceedToCart}
                disabled={selectedAssets.length === 0}
              >
                Review Batch Plan
              </button>
              <button 
                className="btn-secondary"
                type="button"
                onClick={onClearSelection}
                disabled={selectedAssets.length === 0}
              >
                Clear
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
