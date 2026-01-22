import { useState, useEffect, useRef } from 'react';
import { getMarketsForBase, POPULAR_BASES, type MarketPair } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';

interface PairSelectorProps {
  asset1: string;
  asset2: string;
  onPairChange: (base: string, quote: string) => void;
}

export function PairSelector({ asset1, asset2, onPairChange }: PairSelectorProps) {
  const [markets, setMarkets] = useState<MarketPair[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [customQuote, setCustomQuote] = useState('');
  const [isCustomMode, setIsCustomMode] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch markets when base asset changes
  useEffect(() => {
    if (!asset1) return;
    
    const fetchMarkets = async () => {
      setLoadingMarkets(true);
      const data = await getMarketsForBase(asset1);
      setMarkets(data);
      setLoadingMarkets(false);
    };
    
    fetchMarkets();
  }, [asset1]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleBaseSelect = (base: string) => {
    onPairChange(base, '');
    setShowDropdown(true);
    setIsCustomMode(false);
  };

  const handleQuoteSelect = (quote: string) => {
    onPairChange(asset1, quote);
    setShowDropdown(false);
    setIsCustomMode(false);
  };

  const handleCustomSubmit = () => {
    if (customQuote.trim()) {
      onPairChange(asset1, customQuote.trim().toUpperCase());
      setShowDropdown(false);
      setIsCustomMode(false);
      setCustomQuote('');
    }
  };

  return (
    <div className="card mb-2">
      <div className="flex justify-between items-center mb-1">
        <h3>Trading Pair</h3>
        {asset1 && asset2 && (
          <span className="badge pair-badge">
            <AssetIcon asset={asset1} size={16} />
            <span>{asset1}</span>
            <span className="pair-separator">/</span>
            <AssetIcon asset={asset2} size={16} />
            <span>{asset2}</span>
          </span>
        )}
      </div>

      {/* Quick Select Buttons */}
      <div className="quick-select mb-2">
        <span className="text-muted" style={{ fontSize: '0.75rem', marginRight: '0.5rem' }}>
          Quick select:
        </span>
        {POPULAR_BASES.map((base) => (
          <button
            key={base}
            className={`quick-btn ${asset1 === base ? 'active' : ''}`}
            onClick={() => handleBaseSelect(base)}
          >
            <AssetIcon asset={base} size={14} />
            {base}
          </button>
        ))}
      </div>

      {/* Base and Quote Selection */}
      <div className="grid-2">
        <div>
          <label>Base Asset</label>
          <input
            type="text"
            value={asset1}
            onChange={(e) => handleBaseSelect(e.target.value.toUpperCase())}
            placeholder="e.g. XCP"
          />
        </div>
        
        <div className="dropdown-container" ref={dropdownRef}>
          <label>Quote Asset</label>
          <div className="dropdown-input-wrapper">
            <input
              type="text"
              value={isCustomMode ? customQuote : asset2}
              onChange={(e) => {
                setIsCustomMode(true);
                setCustomQuote(e.target.value.toUpperCase());
              }}
              onFocus={() => setShowDropdown(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isCustomMode) {
                  handleCustomSubmit();
                }
              }}
              placeholder={loadingMarkets ? 'Loading...' : 'Select or enter asset'}
            />
            <button 
              className="dropdown-toggle-btn"
              onClick={() => setShowDropdown(!showDropdown)}
              type="button"
            >
              ▼
            </button>
          </div>

          {/* Dropdown */}
          {showDropdown && asset1 && (
            <div className="dropdown-menu-custom">
              {loadingMarkets && (
                <div className="dropdown-item loading">
                  <span className="spinner"></span> Loading markets...
                </div>
              )}
              
              {!loadingMarkets && markets.length === 0 && (
                <div className="dropdown-item empty">
                  No active markets for {asset1}
                </div>
              )}
              
              {!loadingMarkets && markets.length > 0 && (
                <>
                  <div className="dropdown-header">
                    Active Markets ({markets.length})
                  </div>
                  {markets.slice(0, 10).map((market) => (
                    <button
                      key={market.quote}
                      className={`dropdown-item ${asset2 === market.quote ? 'active' : ''}`}
                      onClick={() => handleQuoteSelect(market.quote)}
                    >
                      <span className="dropdown-item-asset">
                        <AssetIcon asset={market.quote} size={18} showStampNumber />
                        <span className="truncate">{market.quote}</span>
                      </span>
                      <span className="dropdown-item-count">
                        {market.orderCount} order{market.orderCount !== 1 ? 's' : ''}
                      </span>
                    </button>
                  ))}
                  {markets.length > 10 && (
                    <div className="dropdown-item empty">
                      +{markets.length - 10} more pairs
                    </div>
                  )}
                </>
              )}
              
              <div className="dropdown-divider"></div>
              <div className="dropdown-item custom-input">
                <input
                  type="text"
                  placeholder="Enter custom asset..."
                  value={customQuote}
                  onChange={(e) => setCustomQuote(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCustomSubmit();
                  }}
                />
                <button 
                  className="btn-secondary"
                  onClick={handleCustomSubmit}
                  disabled={!customQuote.trim()}
                >
                  Go
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
