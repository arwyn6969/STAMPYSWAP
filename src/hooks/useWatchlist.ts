import { useState, useCallback, useEffect } from 'react';

export interface WatchlistPair {
  base: string;
  quote: string;
}

const STORAGE_KEY = 'stampyswap_watchlist';

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState<WatchlistPair[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as WatchlistPair[];
      }
    } catch (err) {
      console.warn('Failed to load watchlist from localStorage', err);
    }
    return [
      { base: 'XCP', quote: 'PEPECASH' }
    ];
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    } catch (err) {
      console.warn('Failed to save watchlist to localStorage', err);
    }
  }, [watchlist]);

  const addPair = useCallback((base: string, quote: string) => {
    setWatchlist(prev => {
      // Don't add duplicates
      if (prev.some(p => p.base === base && p.quote === quote)) return prev;
      return [...prev, { base, quote }];
    });
  }, []);

  const removePair = useCallback((base: string, quote: string) => {
    setWatchlist(prev => prev.filter(p => !(p.base === base && p.quote === quote)));
  }, []);

  const togglePair = useCallback((base: string, quote: string) => {
    setWatchlist(prev => {
      const exists = prev.some(p => p.base === base && p.quote === quote);
      if (exists) {
        return prev.filter(p => !(p.base === base && p.quote === quote));
      } else {
        return [...prev, { base, quote }];
      }
    });
  }, []);

  const isStarred = useCallback((base: string, quote: string) => {
    return watchlist.some(p => p.base === base && p.quote === quote);
  }, [watchlist]);

  return {
    watchlist,
    addPair,
    removePair,
    togglePair,
    isStarred
  };
}
