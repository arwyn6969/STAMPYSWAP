import { type WatchlistPair } from '../hooks/useWatchlist';
import { AssetIcon } from './AssetIcon';

interface WatchlistToolbarProps {
  watchlist: WatchlistPair[];
  currentBase: string;
  currentQuote: string;
  onSelectPair: (base: string, quote: string) => void;
  onRemovePair: (base: string, quote: string) => void;
}

export function WatchlistToolbar({ 
  watchlist, 
  currentBase, 
  currentQuote, 
  onSelectPair, 
  onRemovePair 
}: WatchlistToolbarProps) {
  if (watchlist.length === 0) return null;

  return (
    <div className="watchlist-toolbar">
      <span className="watchlist-toolbar-label">
        Saved Markets
      </span>
      <div className="watchlist-toolbar-list">
        {watchlist.map(pair => {
          const isActive = pair.base === currentBase && pair.quote === currentQuote;
          return (
            <div 
              key={`${pair.base}-${pair.quote}`}
              className={`watchlist-chip ${isActive ? 'is-active' : ''}`}
            >
              <button
                type="button"
                className="watchlist-chip-button"
                aria-pressed={isActive}
                onClick={() => onSelectPair(pair.base, pair.quote)}
              >
                <AssetIcon asset={pair.base} size={12} showStampNumber={false} />
                <span>{pair.base}</span>
                <span className="watchlist-chip-separator">/</span>
                <AssetIcon asset={pair.quote} size={12} showStampNumber={false} />
                <span>{pair.quote}</span>
              </button>
              
              <button 
                className="watchlist-chip-remove"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemovePair(pair.base, pair.quote);
                }}
                title="Remove from watchlist"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
