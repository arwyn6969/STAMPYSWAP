import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  composeOrder,
  getBalances,
  getAssetDivisibility,
  type Balance,
  type ComposeResult,
  type Order,
} from '../lib/counterparty';
import { baseUnitsToInputString, displayToBaseUnits, formatBaseUnits } from '../lib/quantity';
import { getMarketSnapshot, splitOrders } from '../lib/orderBook';

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
    contextLabel?: string;
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
  const [balances, setBalances] = useState<Balance[]>([]);
  const [intent, setIntent] = useState<'sell-base' | 'buy-base'>('sell-base');

  const giveDivisible = giveAsset ? (assetDivisibility[giveAsset] ?? true) : true;
  const getDivisible = getAsset ? (assetDivisibility[getAsset] ?? true) : true;
  const isDivisible = useCallback((asset: string) => assetDivisibility[asset] ?? true, [assetDivisibility]);
  const normalizedBase = giveAssetDefault.trim().toUpperCase();
  const normalizedQuote = getAssetDefault.trim().toUpperCase();

  const { asks, bids } = useMemo(() => splitOrders(orders, normalizedBase, isDivisible), [orders, normalizedBase, isDivisible]);
  const marketSnapshot = useMemo(() => getMarketSnapshot(asks, bids, isDivisible), [asks, bids, isDivisible]);

  useEffect(() => {
    if (!userAddress) {
      setBalances([]);
      return;
    }

    let cancelled = false;
    const loadBalances = async () => {
      try {
        const nextBalances = await getBalances(userAddress);
        if (!cancelled) {
          setBalances(nextBalances);
        }
      } catch {
        if (!cancelled) {
          setBalances([]);
        }
      }
    };

    void loadBalances();
    return () => {
      cancelled = true;
    };
  }, [userAddress]);

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
      if (prefill.giveAsset === normalizedBase) {
        setIntent('sell-base');
      } else if (prefill.giveAsset === normalizedQuote) {
        setIntent('buy-base');
      }
    }
  }, [prefill, giveDivisible, getDivisible, normalizedBase, normalizedQuote]);

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
    if (intent === 'buy-base' && normalizedQuote) {
      setGiveAsset(normalizedQuote);
      setGetAsset(normalizedBase);
      return;
    }
    setGiveAsset(normalizedBase);
    setGetAsset(normalizedQuote);
  }, [normalizedBase, normalizedQuote, intent, prefill]);

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
  const giveBalance = balances.find((balance) => balance.asset === giveAsset);
  const getBalance = balances.find((balance) => balance.asset === getAsset);
  const impliedPrice = giveQuantity && getQuantity
    ? Number.parseFloat(getQuantity || '0') / Math.max(Number.parseFloat(giveQuantity || '0'), Number.MIN_VALUE)
    : 0;
  const pricingHint = useMemo(() => {
    if (!giveQuantity || !getQuantity || !Number.isFinite(impliedPrice) || impliedPrice <= 0) {
      return 'Enter both amounts to compare this draft against the current market.';
    }

    if (intent === 'sell-base') {
      if (marketSnapshot.bestBid > 0 && impliedPrice <= marketSnapshot.bestBid) {
        return 'This sell order is priced to cross the best bid and could fill quickly.';
      }
      if (marketSnapshot.bestAsk > 0 && impliedPrice < marketSnapshot.bestAsk) {
        return 'This sell order sits inside the current spread, which can improve your fill chances.';
      }
      if (marketSnapshot.bestAsk > 0) {
        return 'This sell order is above the current ask stack and may wait for buyers.';
      }
      return 'There are no visible asks yet, so your price will help anchor this market.';
    }

    if (marketSnapshot.bestAsk > 0 && impliedPrice >= marketSnapshot.bestAsk) {
      return 'This buy order is priced to cross the best ask and could fill quickly.';
    }
    if (marketSnapshot.bestBid > 0 && impliedPrice > marketSnapshot.bestBid) {
      return 'This buy order sits inside the current spread, which can improve your queue position.';
    }
    if (marketSnapshot.bestBid > 0) {
      return 'This buy order is below the active bid stack and may wait for sellers.';
    }
    return 'There are no visible bids yet, so your price will help anchor this market.';
  }, [giveQuantity, getQuantity, impliedPrice, intent, marketSnapshot.bestAsk, marketSnapshot.bestBid]);
  const ctaLabel = intent === 'sell-base' ? `Review ${normalizedBase} Sell Order` : `Review ${normalizedBase} Buy Order`;

  const setOrderIntent = (nextIntent: 'sell-base' | 'buy-base') => {
    setIntent(nextIntent);
    setError(null);
    setGiveQuantity('');
    setGetQuantity('');
    if (nextIntent === 'buy-base' && normalizedQuote) {
      setGiveAsset(normalizedQuote);
      setGetAsset(normalizedBase);
      return;
    }
    setGiveAsset(normalizedBase);
    setGetAsset(normalizedQuote);
  };

  return (
    <div className="card trade-form-card">
      <div className="trade-form-header">
        <div>
          <h2>Create Order</h2>
          <p className="trade-form-subtitle">
            Draft a limit order with live market context before you sign.
          </p>
        </div>
        <span className="badge pair-badge">
          {normalizedBase}/{normalizedQuote || '—'}
        </span>
      </div>

      <div className="trade-form-intent">
        <button
          type="button"
          className={`intent-chip ${intent === 'sell-base' ? 'active' : ''}`}
          aria-pressed={intent === 'sell-base'}
          onClick={() => setOrderIntent('sell-base')}
        >
          Sell {normalizedBase}
        </button>
        <button
          type="button"
          className={`intent-chip ${intent === 'buy-base' ? 'active' : ''}`}
          aria-pressed={intent === 'buy-base'}
          onClick={() => setOrderIntent('buy-base')}
          disabled={!normalizedQuote}
        >
          Buy {normalizedBase}
        </button>
      </div>

      <div className="trade-metrics">
        <div className="trade-metric">
          <span className="trade-metric-label">Best Bid</span>
          <span className="trade-metric-value">{marketSnapshot.bestBid ? marketSnapshot.bestBid.toFixed(6) : '—'}</span>
        </div>
        <div className="trade-metric">
          <span className="trade-metric-label">Best Ask</span>
          <span className="trade-metric-value">{marketSnapshot.bestAsk ? marketSnapshot.bestAsk.toFixed(6) : '—'}</span>
        </div>
        <div className="trade-metric">
          <span className="trade-metric-label">Spread</span>
          <span className="trade-metric-value">{marketSnapshot.spread ? `${marketSnapshot.spread.toFixed(2)}%` : '—'}</span>
        </div>
        <div className="trade-metric">
          <span className="trade-metric-label">Balance</span>
          <span className="trade-metric-value">
            {giveBalance ? formatBaseUnits(giveBalance.quantity, giveDivisible) : '—'} {giveAsset || ''}
          </span>
        </div>
      </div>

      <div className="trade-form-brief">
        <div className="trade-form-brief-copy">
          <span className="trade-form-brief-kicker">Draft summary</span>
          <strong>
            {intent === 'sell-base'
              ? `Offer ${normalizedBase || 'your asset'} to receive ${normalizedQuote || 'the quote asset'}`
              : `Spend ${normalizedQuote || 'the quote asset'} to accumulate ${normalizedBase || 'the base asset'}`}
          </strong>
        </div>
        <p className="trade-form-brief-note">{pricingHint}</p>
      </div>

      {prefill?.contextLabel && (
        <div className="trade-context-banner">
          {prefill.contextLabel}. Review the quantities before continuing.
        </div>
      )}
      
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="trade-section-shell">
          <div className="trade-section-header">
            <span className="trade-section-step">1</span>
            <div>
              <div className="trade-section-title">Funding leg</div>
              <div className="trade-section-copy">Choose the asset and quantity you are committing to this order.</div>
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>You Pay With</label>
              <input
                type="text"
                placeholder="Asset (e.g. XCP)"
                value={giveAsset}
                onChange={(e) => setGiveAsset(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <div className="field-label-row">
                <label>Amount</label>
                {giveBalance && (
                  <button
                    type="button"
                    className="field-inline-action"
                    onClick={() => setGiveQuantity(baseUnitsToInputString(giveBalance.quantity, giveDivisible))}
                  >
                    Max
                  </button>
                )}
              </div>
              <input
                type="number"
                step={giveDivisible ? '0.00000001' : '1'}
                min="0"
                placeholder="0.00000000"
                value={giveQuantity}
                onChange={(e) => setGiveQuantity(e.target.value)}
              />
              {giveBalance && (
                <p className="field-helper">
                  Available: {formatBaseUnits(giveBalance.quantity, giveDivisible)} {giveAsset}
                </p>
              )}
              {!giveDivisible && (
                <p className="field-helper">
                  This asset is indivisible and only allows whole units.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="trade-section-shell">
          <div className="trade-section-header">
            <span className="trade-section-step">2</span>
            <div>
              <div className="trade-section-title">Target leg</div>
              <div className="trade-section-copy">Set what you want back from the market and the size of that return.</div>
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>You Receive</label>
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
              {getBalance && (
                <p className="field-helper">
                  Current holding: {formatBaseUnits(getBalance.quantity, getDivisible)} {getAsset}
                </p>
              )}
              {!getDivisible && (
                <p className="field-helper">
                  This asset is indivisible and only allows whole units.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="trade-section-shell">
          <div className="trade-section-header">
            <span className="trade-section-step">3</span>
            <div>
              <div className="trade-section-title">Review rules</div>
              <div className="trade-section-copy">Confirm timing, implied price, and how the order sits in the current market.</div>
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

          <div className="trade-summary-row">
            <span className="trade-summary-label">Implied Price</span>
            <span className="trade-summary-value">
              {giveQuantity && getQuantity && Number.isFinite(impliedPrice)
                ? `1 ${giveAsset || 'asset'} = ${impliedPrice.toFixed(6)} ${getAsset || 'asset'}`
                : 'Enter amounts to see the draft price'}
            </span>
          </div>

          <div className="trade-summary-row">
            <span className="trade-summary-label">Market Read</span>
            <span className="trade-summary-value">{pricingHint}</span>
          </div>
        </div>

        {error && <div className="form-feedback form-feedback-error">{error}</div>}
        {spreadWarning && (
          <div className={`form-feedback ${spreadWarning.level === 'danger' ? 'form-feedback-danger' : 'form-feedback-warning'}`}>
            <p className="form-feedback-title">
              {spreadWarning.level === 'danger' ? 'Extreme slippage detected' : 'Slippage warning'}
            </p>
            <p className="form-feedback-copy">{spreadWarning.message}</p>
          </div>
        )}

        <button 
          type="submit" 
          className="btn-primary trade-submit-btn"
          disabled={loading || !isFormValid}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-1">
              <span className="spinner"></span> Composing...
            </span>
          ) : (
            ctaLabel
          )}
        </button>

        {!userAddress && (
          <p className="trade-form-footnote text-muted text-center">
            Connect a wallet to compose and sign orders
          </p>
        )}
      </form>
    </div>
  );
}
