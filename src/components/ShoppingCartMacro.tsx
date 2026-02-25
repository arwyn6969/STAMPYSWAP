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
          // Filter to only the selected assets
          setBalances(data.filter(b => selectedAssets.includes(b.asset)));
        }
      } catch (err) {
        console.error("Failed to load balances for macro", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    
    void fetchBals();
    return () => { cancelled = true; };
  }, [isOpen, selectedAssets, userAddress]);

  if (!isOpen) return null;

  const handleExecute = async () => {
    // Generate the order params for each selected asset
    const parsedPrice = parseFloat(pricePerUnit);
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      alert("Please enter a valid price per unit.");
      return;
    }

    if (!targetAsset.trim()) {
      alert("Please enter a valid target asset.");
      return;
    }

    const exp = parseInt(expiration, 10);
    if (isNaN(exp) || exp <= 0) {
      alert("Please enter a valid expiration.");
      return;
    }

    setLoading(true);
    try {
      // Pre-fetch divisibility for the target asset if not in cache
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
        
        // Exact Math Formatting for Divisible vs Indivisible
        let getAmountTotalStr;
        if (targetDivisible) {
          getAmountTotalStr = (giveAmountNumber * parsedPrice).toFixed(8); // Ensure max 8 decimals
        } else {
          getAmountTotalStr = Math.round(giveAmountNumber * parsedPrice).toString(); // Whole numbers only
        }
        
        const getQty = displayToBaseUnits(getAmountTotalStr, targetDivisible);

        // Safety Zero-Check
        if (giveQty <= 0n || getQty <= 0n) {
          return null; // Skip if math zeroed out token limits
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
         alert(`Skipped ${balances.length - validParams.length} token(s) due to calculated quantity rounding to exactly zero (cannot sell 50% of 1 indivisible token, etc).`);
      }
      
      if (validParams.length > 0) {
        onExecuteBatch(validParams);
      }
    } catch (err) {
      alert("Failed to build orders: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}>
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 pointer-events-auto" 
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', transition: 'opacity 0.3s' }}
        onClick={onClose}
      />
      
      {/* Drawer */}
      <div 
        className="absolute right-0 top-0 bottom-0 w-[400px] bg-base-100 shadow-2xl pointer-events-auto flex flex-col"
        style={{ 
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '400px', 
          background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-color)',
          display: 'flex', flexDirection: 'column', padding: '1.5rem', overflowY: 'auto'
        }}
      >
        <div className="flex justify-between items-center mb-4 border-b pb-2" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', margin: 0 }}>🛒 Macro Strategy</h2>
          <button className="btn-icon" onClick={onClose} style={{ padding: '0.25rem 0.5rem' }}>✕</button>
        </div>

        {loading ? (
          <div className="loading-state flex flex-col items-center p-4">
             <span className="spinner"></span>
             <p className="text-muted mt-2 text-sm">Loading wallet balances...</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="card" style={{ padding: '1rem', backgroundColor: 'var(--bg-card)' }}>
               <h3 className="mb-2 text-sm font-bold">Selected Assets ({balances.length})</h3>
               <div className="flex flex-wrap gap-2" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                 {balances.map(b => (
                   <div key={b.asset} className="badge badge-primary flex items-center gap-1" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                     <AssetIcon asset={b.asset} size={14} showStampNumber={false} />
                     {b.asset}
                   </div>
                 ))}
               </div>
            </div>

            <div className="card" style={{ padding: '1rem', backgroundColor: 'var(--bg-card)' }}>
              <h3 className="mb-2 text-sm font-bold">Strategy Builder</h3>
              
              <div className="flex flex-col gap-3" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label>I want to sell...</label>
                  <div className="flex gap-2 mt-1" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <button 
                      className={`flex-1 ${sellPercentage === 100 ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ flex: 1 }}
                      onClick={() => setSellPercentage(100)}
                    >
                      100%
                    </button>
                    <button 
                       className={`flex-1 ${sellPercentage === 50 ? 'btn-primary' : 'btn-secondary'}`}
                       style={{ flex: 1 }}
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
                     style={{ marginTop: '0.25rem' }}
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
                     style={{ marginTop: '0.25rem' }}
                   />
                </div>

                <div>
                  <label>Expiration (blocks)</label>
                  <input
                    type="number"
                    min="1"
                    value={expiration}
                    onChange={(e) => setExpiration(e.target.value)}
                    style={{ marginTop: '0.25rem' }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-2 text-muted" style={{ fontSize: '0.75rem', lineHeight: 1.4 }}>
              <p>⚡ <strong>Sequential Execution:</strong> Clicking execute will generate {balances.length} separate orders. You will be prompted to sign and broadcast each one sequentially due to Bitcoin UTXO constraints.</p>
            </div>

            <button 
               className="btn-primary mt-2 flex justify-center items-center gap-2" 
               style={{ width: '100%', padding: '0.75rem', fontSize: '1rem', fontWeight: 'bold', marginTop: '1rem' }}
               onClick={handleExecute}
            >
              🚀 Queue {balances.length} Orders
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
