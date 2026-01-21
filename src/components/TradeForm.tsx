import { useState } from 'react';
import { composeOrder, type ComposeResult } from '../lib/counterparty';

interface TradeFormProps {
  userAddress: string;
  onOrderComposed: (result: ComposeResult) => void;
  giveAssetDefault?: string;
  getAssetDefault?: string;
}

export function TradeForm({ 
  userAddress, 
  onOrderComposed,
  giveAssetDefault = 'XCP',
  getAssetDefault = ''
}: TradeFormProps) {
  const [giveAsset, setGiveAsset] = useState(giveAssetDefault);
  const [giveQuantity, setGiveQuantity] = useState('');
  const [getAsset, setGetAsset] = useState(getAssetDefault);
  const [getQuantity, setGetQuantity] = useState('');
  const [expiration, setExpiration] = useState('100');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Convert to satoshis (assuming divisible assets)
      const giveQty = Math.round(parseFloat(giveQuantity) * 100000000);
      const getQty = Math.round(parseFloat(getQuantity) * 100000000);

      if (isNaN(giveQty) || isNaN(getQty) || giveQty <= 0 || getQty <= 0) {
        throw new Error('Invalid quantities');
      }

      const result = await composeOrder({
        address: userAddress,
        give_asset: giveAsset.toUpperCase(),
        give_quantity: giveQty,
        get_asset: getAsset.toUpperCase(),
        get_quantity: getQty,
        expiration: parseInt(expiration, 10),
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
              step="0.00000001"
              min="0"
              placeholder="0.00000000"
              value={giveQuantity}
              onChange={(e) => setGiveQuantity(e.target.value)}
            />
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
              step="0.00000001"
              min="0"
              placeholder="0.00000000"
              value={getQuantity}
              onChange={(e) => setGetQuantity(e.target.value)}
            />
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

        <button 
          type="submit" 
          className="btn-primary"
          disabled={loading || !isFormValid}
        >
          {loading ? (
            <span className="flex items-center justify-content gap-1">
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
