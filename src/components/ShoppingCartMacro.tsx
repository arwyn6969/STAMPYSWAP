import { useState, useEffect } from 'react';
import { getBalances, getAssetDivisibility, type Balance } from '../lib/counterparty';
import { AssetIcon } from './AssetIcon';
import { baseUnitsToNumber, displayToBaseUnits } from '../lib/quantity';

export interface MacroOrderParams {
  give_asset: string;
  give_quantity: bigint;
  get_asset: string;
  get_quantity: bigint;
  expiration: number;
}

interface ShoppingCartMacroProps {
  userAddress: string;
  selectedAssets: string[];
  isOpen: boolean;
  onClose: () => void;
  onExecuteBatch: (params: MacroOrderParams[]) => void;
}

export function ShoppingCartMacro({ userAddress, selectedAssets, isOpen, onClose, onExecuteBatch }: ShoppingCartMacroProps) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  
  // Strategy State
  const [targetAsset, setTargetAsset] = useState('XCP');
  const [pricePerUnit, setPricePerUnit] = useState('1');
  const [sellPercentage, setSellPercentage] = useState<100 | 50>(100);
  const [expiration, setExpiration] = useState('100');
  const [divisibilityCache, setDivisibilityCache] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen || selectedAssets.length === 0) return;
    
    let cancelled = false;
    const fetchBals = async () => {
      setLoading(true);
      try {
        const data = await getBalances(userAddress);
        if (!cancelled) {
          setBalances(data.filter(b => selectedAssets.includes(b.asset)));
          setFormError(null);
        }
      } catch {
        if (!cancelled) {
          setFormError('Unable to load the selected balances for this batch plan.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    
    void fetchBals();
    return () => { cancelled = true; };
  }, [isOpen, selectedAssets, userAddress]);

  if (!isOpen) return null;

  const handleExecute = async () => {
    setFormError(null);
    setNotice(null);
    const parsedPrice = parseFloat(pricePerUnit);
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      setFormError('Enter a valid price per unit.');
      return;
    }

    if (!targetAsset.trim()) {
      setFormError('Enter a valid target asset.');
      return;
    }

    const exp = parseInt(expiration, 10);
    if (isNaN(exp) || exp <= 0) {
      setFormError('Enter a valid expiration.');
      return;
    }

    setLoading(true);
    try {
      let targetDivisible = divisibilityCache[targetAsset];
      if (targetDivisible === undefined) {
        targetDivisible = await getAssetDivisibility(targetAsset);
        setDivisibilityCache(prev => ({ ...prev, [targetAsset]: targetDivisible }));
      }

      const generatedParams = await Promise.all(balances.map(async b => {
        let giveDivisible = divisibilityCache[b.asset];
        if (giveDivisible === undefined) {
          giveDivisible = await getAssetDivisibility(b.asset);
          setDivisibilityCache(prev => ({ ...prev, [b.asset]: giveDivisible }));
        }

        const giveQty = sellPercentage === 100 ? b.quantity : (b.quantity / 2n);
        const giveAmountNumber = baseUnitsToNumber(giveQty, giveDivisible);
        
        let getAmountTotalStr;
        if (targetDivisible) {
          getAmountTotalStr = (giveAmountNumber * parsedPrice).toFixed(8);
        } else {
          getAmountTotalStr = Math.round(giveAmountNumber * parsedPrice).toString();
        }
        
        const getQty = displayToBaseUnits(getAmountTotalStr, targetDivisible);

        if (giveQty <= 0n || getQty <= 0n) {
          return null;
        }

        return {
          give_asset: b.asset,
          give_quantity: giveQty,
          get_asset: targetAsset,
          get_quantity: getQty,
          expiration: exp
        } as MacroOrderParams;
      }));

      const validParams = generatedParams.filter((p): p is MacroOrderParams => p !== null);
      
      if (validParams.length < balances.length) {
        setNotice(`Skipped ${balances.length - validParams.length} asset(s) because the calculated quantity rounded to zero.`);
      }
      
      if (validParams.length > 0) {
        onExecuteBatch(validParams);
      }
    } catch (err) {
      setFormError(`Failed to build orders: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-overlay">
      <div className="app-backdrop" onClick={onClose} />
      <aside className="app-drawer app-drawer-wide" aria-label="Batch Listing Plan">
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">Batch Listing Plan</h2>
            <p className="drawer-subtitle">Build a repeatable sell rule across the assets you selected in the portfolio.</p>
          </div>
          <button className="btn-icon drawer-close-btn" type="button" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div className="loading-state utility-loading-state">
             <span className="spinner"></span>
             <p className="text-muted utility-loading-copy">Loading wallet balances...</p>
          </div>
        ) : (
          <div className="drawer-content">
            <div className="trade-context-banner drawer-banner">
              Turn the selected assets into individually signed sell orders. Each order still requires its own wallet approval or QR signature.
            </div>

            <div className="drawer-status-card">
               <h3 className="drawer-section-title">Selected Assets ({balances.length})</h3>
               <div className="drawer-chip-list">
                 {balances.map(b => (
                   <div key={b.asset} className="badge badge-primary drawer-chip">
                     <AssetIcon asset={b.asset} size={14} showStampNumber={false} />
                     {b.asset}
                   </div>
                 ))}
               </div>
            </div>

            <div className="drawer-status-card">
              <h3 className="drawer-section-title">Plan Builder</h3>
              
              <div className="drawer-form-grid">
                <div>
                  <label>I want to sell...</label>
                  <div className="drawer-toggle-row">
                    <button 
                      type="button"
                      className={`${sellPercentage === 100 ? 'btn-primary' : 'btn-secondary'} drawer-toggle-btn`}
                      onClick={() => setSellPercentage(100)}
                    >
                      100%
                    </button>
                    <button 
                       type="button"
                       className={`${sellPercentage === 50 ? 'btn-primary' : 'btn-secondary'} drawer-toggle-btn`}
                       onClick={() => setSellPercentage(50)}
                    >
                       50%
                    </button>
                  </div>
                </div>

                <div>
                   <label>Of each asset, for...</label>
                   <input 
                     type="text" 
                     placeholder="Asset (e.g. XCP, PEPECASH)" 
                     value={targetAsset}
                     onChange={e => setTargetAsset(e.target.value.toUpperCase())}
                   />
                </div>

                <div>
                   <label>At a price of ({targetAsset} per token)</label>
                   <input 
                     type="number" 
                     min="0.00000001"
                     step="any"
                     placeholder="e.g. 1.5" 
                     value={pricePerUnit}
                     onChange={e => setPricePerUnit(e.target.value)}
                   />
                </div>

                <div>
                  <label>Expiration (blocks)</label>
                  <input
                    type="number"
                    min="1"
                    value={expiration}
                    onChange={(e) => setExpiration(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="drawer-status-card">
              <h3 className="drawer-section-title">Preview</h3>
              <div className="trade-summary-row">
                <span className="trade-summary-label">Orders</span>
                <span className="trade-summary-value">{balances.length}</span>
              </div>
              <div className="trade-summary-row">
                <span className="trade-summary-label">Target asset</span>
                <span className="trade-summary-value">{targetAsset || '—'}</span>
              </div>
              <div className="trade-summary-row">
                <span className="trade-summary-label">Sale size</span>
                <span className="trade-summary-value">{sellPercentage}% of each selected asset</span>
              </div>
              <div className="trade-summary-row">
                <span className="trade-summary-label">Price rule</span>
                <span className="trade-summary-value">{pricePerUnit || '—'} {targetAsset || 'asset'} per token</span>
              </div>
            </div>

            {formError && (
              <div className="form-feedback form-feedback-error">{formError}</div>
            )}

            {notice && (
              <div className="trade-context-banner drawer-banner">
                {notice}
              </div>
            )}

            <div className="drawer-footnote text-muted">
              <p>Sequential execution: this will generate {balances.length} separate orders, and you will sign or broadcast them one at a time because of Bitcoin UTXO constraints.</p>
            </div>

            <button 
               className="btn-primary drawer-primary-btn" 
               type="button"
               onClick={handleExecute}
            >
              Build {balances.length} Order{balances.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
