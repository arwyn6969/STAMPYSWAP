import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ComposeResult } from '../lib/counterparty';
import { getCurrentConnection, signAndBroadcast } from '../lib/wallet';
import { extractTxid } from '../lib/transaction';
import { getBitcoinExplorerLabel, getBitcoinExplorerTxUrl } from '../lib/explorer';

interface QRSignerProps {
  composeResult: ComposeResult | null;
  onClose: () => void;
  onBroadcast?: (txid: string) => void;
  onTrackTxid?: (txid: string) => void;
}

export function QRSigner({ composeResult, onClose, onBroadcast, onTrackTxid }: QRSignerProps) {
  const [signing, setSigning] = useState(false);
  const [signResult, setSignResult] = useState<{ success: boolean; txid?: string; error?: string } | null>(null);
  const [manualTxidInput, setManualTxidInput] = useState('');
  const [manualTxidError, setManualTxidError] = useState<string | null>(null);

  if (!composeResult) return null;

  const txHex = composeResult.rawtransaction;
  const psbtHex = composeResult.psbt;
  
  // Check current connection to determine signing capability
  const connection = getCurrentConnection();
  const hasWalletConnection = Boolean(connection && connection.walletType !== 'manual');
  const canWalletSign = Boolean(hasWalletConnection && psbtHex);
  const walletType = connection?.walletType;

  const handleWalletSign = async () => {
    if (!psbtHex) return;
    
    setSigning(true);
    setSignResult(null);
    
    try {
      const txid = await signAndBroadcast(psbtHex);
      setSignResult({ success: true, txid });
      onBroadcast?.(txid);
    } catch (err) {
      setSignResult({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Failed to sign transaction' 
      });
    } finally {
      setSigning(false);
    }
  };

  const handleTrackTxid = () => {
    const txid = extractTxid(manualTxidInput);
    if (!txid) {
      setManualTxidError('Enter a valid 64-character transaction ID or explorer URL.');
      return;
    }
    setManualTxidError(null);
    setManualTxidInput(txid);
    onTrackTxid?.(txid);
  };

  return (
    <div className="app-overlay" onClick={onClose}>
      <div className="app-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">Sign Transaction</h2>
            <p className="modal-subtitle">Approve the composed order with your connected wallet or the QR signing flow.</p>
          </div>
          <button className="btn-icon drawer-close-btn" type="button" onClick={onClose}>✕</button>
        </div>
        
        {signResult?.success && signResult.txid && (
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <div className="empty-state-title">Transaction Broadcast!</div>
            <div className="empty-state-text">
              <a 
                href={getBitcoinExplorerTxUrl(signResult.txid)}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-link"
              >
                View on {getBitcoinExplorerLabel()} →
              </a>
            </div>
            <button className="btn-primary modal-primary-btn" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {signResult?.success === false && (
          <div className="empty-state">
            <div className="empty-state-icon">❌</div>
            <div className="empty-state-title">Signing Failed</div>
            <div className="empty-state-text text-error">{signResult.error}</div>
            <button className="btn-secondary modal-primary-btn" type="button" onClick={() => setSignResult(null)}>
              Try Again
            </button>
          </div>
        )}

        {!signResult && (
          <>
            {canWalletSign && (
              <div className="modal-section">
                <button 
                  className="btn-primary modal-wallet-btn" 
                  onClick={handleWalletSign}
                  disabled={signing}
                  type="button"
                >
                  {signing ? (
                    <span className="flex items-center gap-1 modal-inline-center">
                      <span className="spinner"></span> Signing...
                    </span>
                  ) : (
                    <>
                      {walletType === 'leather' && '🔷 '}
                      {walletType === 'xverse' && '🟣 '}
                      Sign with {walletType && walletType.charAt(0).toUpperCase() + walletType.slice(1)}
                    </>
                  )}
                </button>
                <p className="modal-note text-muted">
                  Your wallet will prompt you to review and sign the transaction.
                </p>
              </div>
            )}

            {hasWalletConnection && !psbtHex && (
              <p className="modal-note text-warning">
                Wallet signing is unavailable for this compose result (missing PSBT). Use QR signing instead.
              </p>
            )}

            <div className="divider modal-divider">
              <span className="text-muted modal-divider-label">
                {canWalletSign ? 'or scan with Freewallet' : 'Scan with Freewallet Mobile'}
              </span>
            </div>

            {connection?.walletType === 'manual' && (
              <p className="modal-note text-warning">
                Watch-only address detected. Use Freewallet to sign.
              </p>
            )}

            <div className="qr-container modal-qr-section">
              <QRCodeSVG 
                value={`counterparty:?action=signtx&tx=${txHex}`} 
                size={200}
                level="L"
                includeMargin
              />
            </div>

            <p className="modal-note text-muted">
              Open Freewallet app → Tools → Scan QR → Confirm to sign &amp; broadcast
            </p>

            <div className="modal-section">
              <label className="modal-field-label">Track Broadcasted Tx</label>
              <div className="flex gap-1">
                <input
                  type="text"
                  placeholder="Paste txid or explorer URL"
                  value={manualTxidInput}
                  onChange={(e) => setManualTxidInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleTrackTxid();
                    }
                  }}
                />
                <button className="btn-secondary" type="button" onClick={handleTrackTxid}>
                  Track
                </button>
              </div>
              {manualTxidError && (
                <p className="modal-field-error text-error">
                  {manualTxidError}
                </p>
              )}
            </div>

            <details className="modal-details">
              <summary className="text-muted modal-details-summary">
                View transaction hex
              </summary>
              <textarea
                readOnly
                value={txHex}
                className="modal-textarea"
              />
            </details>

            <button className="btn-secondary modal-secondary-btn" type="button" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
