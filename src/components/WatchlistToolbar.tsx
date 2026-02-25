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
    <div className="flex flex-wrap gap-2 items-center mb-3 p-2 rounded bg-base-100 border border-[var(--border-color)]">
      <span className="text-muted text-xs font-bold uppercase tracking-wider" style={{ paddingLeft: '0.5rem', marginRight: '0.5rem' }}>
        ⭐ Watchlist
      </span>
      <div className="flex gap-2 flex-wrap items-center">
        {watchlist.map(pair => {
          const isActive = pair.base === currentBase && pair.quote === currentQuote;
          return (
            <div 
              key={`${pair.base}-${pair.quote}`}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs cursor-pointer transition-colors ${
                isActive 
                  ? 'bg-[var(--accent-primary)] text-white font-bold' 
                  : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border-color)]'
              }`}
              onClick={() => onSelectPair(pair.base, pair.quote)}
            >
              <AssetIcon asset={pair.base} size={12} showStampNumber={false} />
              <span>{pair.base}</span>
              <span className="opacity-50 mx-0.5">/</span>
              <AssetIcon asset={pair.quote} size={12} showStampNumber={false} />
              <span>{pair.quote}</span>
              
              <button 
                className="ml-1 opacity-50 hover:opacity-100 hover:text-error"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemovePair(pair.base, pair.quote);
                }}
                title="Remove from watchlist"
                style={{ background: 'none', border: 'none', padding: 0, fontSize: '10px' }}
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
