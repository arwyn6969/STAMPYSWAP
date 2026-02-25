import { useState, useEffect, useMemo } from 'react';
import {
  composeOrder,
  getAssetDivisibility,
  type ComposeResult,
  type Order,
} from '../lib/counterparty';
import { baseUnitsToInputString, displayToBaseUnits } from '../lib/quantity';

interface TradeFormProps {
  userAddress: string;
  onOrderComposed: (result: ComposeResult) => void;
  giveAssetDefault?: string;
  getAssetDefault?: string;
  prefill?: {
    giveAsset: string;
    getAsset: string;
    giveQuantity: bigint;
    getQuantity: bigint;
    lock?: boolean;
  } | null;
  orders?: Order[];
}

export function TradeForm({ 
  userAddress, 
  onOrderComposed,
  giveAssetDefault = 'XCP',
  getAssetDefault = '',
  prefill,
  orders = []
}: TradeFormProps) {
  const [giveAsset, setGiveAsset] = useState(giveAssetDefault);
  const [giveQuantity, setGiveQuantity] = useState('');
  const [getAsset, setGetAsset] = useState(getAssetDefault);
  const [getQuantity, setGetQuantity] = useState('');
  const [expiration, setExpiration] = useState('100');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetDivisibility, setAssetDivisibility] = useState<Record<string, boolean>>({});

  const giveDivisible = giveAsset ? (assetDivisibility[giveAsset] ?? true) : true;
  const getDivisible = getAsset ? (assetDivisibility[getAsset] ?? true) : true;

  useEffect(() => {
    let cancelled = false;
    const assets = [giveAsset, getAsset]
      .map((asset) => asset.trim().toUpperCase())
      .filter(Boolean);
    const uniqueAssets = Array.from(new Set(assets));
    if (uniqueAssets.length === 0) return undefined;

    const load = async () => {
      const entries = await Promise.all(
        uniqueAssets.map(async (asset) => [asset, await getAssetDivisibility(asset)] as const),
      );
      if (cancelled) return;
      setAssetDivisibility((prev) => {
        const next = { ...prev };
        for (const [asset, divisible] of entries) {
          next[asset] = divisible;
        }
        return next;
      });
    };

    load().catch(() => {
      // Use default divisibility fallback when metadata calls fail.
    });

    return () => {
      cancelled = true;
    };
  }, [giveAsset, getAsset]);

  useEffect(() => {
    if (prefill) {
      setGiveAsset(prefill.giveAsset);
      setGetAsset(prefill.getAsset);
      setGiveQuantity(baseUnitsToInputString(prefill.giveQuantity, giveDivisible));
      setGetQuantity(baseUnitsToInputString(prefill.getQuantity, getDivisible));
    }
  }, [prefill, giveDivisible, getDivisible]);

  const spreadWarning = useMemo(() => {
    if (!orders || orders.length === 0) return null;
    if (!giveAsset || !getAsset || !giveQuantity || !getQuantity) return null;
    if (loading) return null;

    const opposingOrders = orders.filter(
      (o) => o.give_asset === getAsset && o.get_asset === giveAsset && o.status === 'open'
    );

    if (opposingOrders.length === 0) return null;

    const getBestMarketRate = () => {
      let best = 0;
      for (const o of opposingOrders) {
        const theirGive = Number(o.give_remaining) / (getDivisible ? 1e8 : 1);
        const theirGet = Number(o.get_remaining) / (giveDivisible ? 1e8 : 1);
        const rate = theirGive / theirGet;
        if (rate > best) best = rate;
      }
      return best;
    };

    const bestMarketRate = getBestMarketRate();
    if (bestMarketRate <= 0) return null;

    const userGive = parseFloat(giveQuantity);
    const userGet = parseFloat(getQuantity);
    if (!userGive || !userGet) return null;

    const userRate = userGet / userGive;

    if (userRate < bestMarketRate) {
      const worseByPercent = ((bestMarketRate - userRate) / bestMarketRate) * 100;
      if (worseByPercent > 20) {
        return { 
          level: 'danger', 
          message: `DANGER: You are bidding ${worseByPercent.toFixed(1)}% worse than the current market floor!` 
        };
      } else if (worseByPercent > 10) {
        return { 
          level: 'warning', 
          message: `Warning: You are bidding ${worseByPercent.toFixed(1)}% worse than the current market spread.` 
        };
      }
    }

    return null;
  }, [orders, giveAsset, getAsset, giveQuantity, getQuantity, giveDivisible, getDivisible, loading]);

  useEffect(() => {
    if (prefill) return;
    setGiveAsset(giveAssetDefault);
    setGetAsset(getAssetDefault);
  }, [giveAssetDefault, getAssetDefault, prefill]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userAddress) {
      setError('Please connect a wallet first');
      return;
    }

    if (!giveAsset || !getAsset || !giveQuantity || !getQuantity) {
      setError('Please fill in all fields');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const giveQty = displayToBaseUnits(giveQuantity, giveDivisible);
      const getQty = displayToBaseUnits(getQuantity, getDivisible);
      const expirationValue = Number.parseInt(expiration, 10);

      if (giveQty <= 0n || getQty <= 0n) {
        throw new Error('Invalid quantities');
      }
      if (!Number.isFinite(expirationValue) || expirationValue <= 0) {
        throw new Error('Expiration must be a positive integer');
      }

      const result = await composeOrder({
        address: userAddress,
        give_asset: giveAsset.toUpperCase(),
        give_quantity: giveQty,
        get_asset: getAsset.toUpperCase(),
        get_quantity: getQty,
        expiration: expirationValue,
      });

      onOrderComposed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compose order');
    } finally {
      setLoading(false);
    }
  };

  const isFormValid = giveAsset && getAsset && giveQuantity && getQuantity && userAddress;

  return (
    <div className="card">
      <h2>Create Order</h2>
      
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="grid-2">
          <div>
            <label>You Give</label>
            <input
              type="text"
              placeholder="Asset (e.g. XCP)"
              value={giveAsset}
              onChange={(e) => setGiveAsset(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label>Amount</label>
            <input
              type="number"
              step={giveDivisible ? '0.00000001' : '1'}
              min="0"
              placeholder="0.00000000"
              value={giveQuantity}
              onChange={(e) => setGiveQuantity(e.target.value)}
            />
            {!giveDivisible && (
              <p className="text-muted" style={{ fontSize: '0.625rem', marginTop: '0.25rem' }}>
                This asset is indivisible and only allows whole units.
              </p>
            )}
          </div>
        </div>

        <div className="grid-2">
          <div>
            <label>You Get</label>
            <input
              type="text"
              placeholder="Asset (e.g. PEPECASH)"
              value={getAsset}
              onChange={(e) => setGetAsset(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label>Amount</label>
            <input
              type="number"
              step={getDivisible ? '0.00000001' : '1'}
              min="0"
              placeholder="0.00000000"
              value={getQuantity}
              onChange={(e) => setGetQuantity(e.target.value)}
            />
            {!getDivisible && (
              <p className="text-muted" style={{ fontSize: '0.625rem', marginTop: '0.25rem' }}>
                This asset is indivisible and only allows whole units.
              </p>
            )}
          </div>
        </div>

        <div>
          <label>Expiration (blocks, ~10 min each)</label>
          <input
            type="number"
            min="1"
            value={expiration}
            onChange={(e) => setExpiration(e.target.value)}
          />
        </div>

        {error && <p className="text-error" style={{ fontSize: '0.875rem' }}>{error}</p>}
        {spreadWarning && (
          <div 
            className={`card text-${spreadWarning.level === 'danger' ? 'error' : 'warning'} bg-${spreadWarning.level === 'danger' ? 'error' : 'warning'}-light`} 
            style={{ 
              padding: '0.75rem', 
              border: `1px solid var(--${spreadWarning.level === 'danger' ? 'error' : 'warning'})`,
              animation: spreadWarning.level === 'danger' ? 'pulse 2s infinite' : 'none'
            }}
          >
             <p style={{ fontSize: '0.875rem', fontWeight: 'bold' }}>
               {spreadWarning.level === 'danger' ? '🚨 Extreme Slippage Detected' : '⚠️ Slippage Warning'}
             </p>
             <p style={{ fontSize: '0.75rem' }}>{spreadWarning.message}</p>
          </div>
        )}

        <button 
          type="submit" 
          className="btn-primary"
          disabled={loading || !isFormValid}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-1">
              <span className="spinner"></span> Composing...
            </span>
          ) : (
            'Create Order'
          )}
        </button>

        {!userAddress && (
          <p className="text-muted text-center" style={{ fontSize: '0.75rem' }}>
            Connect a wallet to create orders
          </p>
        )}
      </form>
    </div>
  );
}
