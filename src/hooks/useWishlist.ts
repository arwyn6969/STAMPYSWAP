import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'stampyswap_wishlist';
const MAX_WISHLIST_SIZE = 20;

export function useWishlist() {
  const [wishlist, setWishlist] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_WISHLIST_SIZE);
        }
      }
    } catch {
      // Ignore parse errors
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wishlist));
    } catch {
      // Ignore storage errors
    }
  }, [wishlist]);

  const addAsset = useCallback((asset: string) => {
    const normalized = asset.trim().toUpperCase();
    if (!normalized) return;
    setWishlist(prev => {
      if (prev.includes(normalized)) return prev;
      if (prev.length >= MAX_WISHLIST_SIZE) return prev;
      return [...prev, normalized];
    });
  }, []);

  const removeAsset = useCallback((asset: string) => {
    const normalized = asset.trim().toUpperCase();
    setWishlist(prev => prev.filter(a => a !== normalized));
  }, []);

  const toggleAsset = useCallback((asset: string) => {
    const normalized = asset.trim().toUpperCase();
    if (!normalized) return;
    setWishlist(prev => {
      if (prev.includes(normalized)) {
        return prev.filter(a => a !== normalized);
      }
      if (prev.length >= MAX_WISHLIST_SIZE) return prev;
      return [...prev, normalized];
    });
  }, []);

  const hasAsset = useCallback((asset: string) => {
    return wishlist.includes(asset.trim().toUpperCase());
  }, [wishlist]);

  const clearAll = useCallback(() => {
    setWishlist([]);
  }, []);

  return {
    wishlist,
    addAsset,
    removeAsset,
    toggleAsset,
    hasAsset,
    clearAll,
  };
}
