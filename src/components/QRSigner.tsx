import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ComposeResult } from '../lib/counterparty';
import { getCurrentConnection, signAndBroadcast } from '../lib/wallet';
import { extractTxid } from '../lib/transaction';

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
    <div 
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div 
        className="card"
        style={{ maxWidth: '400px', textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Sign Transaction</h2>
        
        {/* Success State */}
        {signResult?.success && (
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <div className="empty-state-title">Transaction Broadcast!</div>
            <div className="empty-state-text">
              <a 
                href={`https://xchain.io/tx/${signResult.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent-primary)' }}
              >
                View on XChain →
              </a>
            </div>
            <button className="btn-primary" onClick={onClose} style={{ marginTop: '1rem' }}>
              Done
            </button>
          </div>
        )}

        {/* Error State */}
        {signResult?.success === false && (
          <div className="empty-state">
            <div className="empty-state-icon">❌</div>
            <div className="empty-state-title">Signing Failed</div>
            <div className="empty-state-text text-error">{signResult.error}</div>
            <button className="btn-secondary" onClick={() => setSignResult(null)} style={{ marginTop: '1rem' }}>
              Try Again
            </button>
          </div>
        )}

        {/* Normal State - Show signing options */}
        {!signResult && (
          <>
            {/* Wallet Signing Option - Only if we have wallet connection */}
            {canWalletSign && (
              <div className="mb-2">
                <button 
                  className="btn-primary" 
                  onClick={handleWalletSign}
                  disabled={signing}
                  style={{ width: '100%' }}
                >
                  {signing ? (
                    <span className="flex items-center gap-1" style={{ justifyContent: 'center' }}>
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
                <p className="text-muted" style={{ fontSize: '0.625rem', marginTop: '0.5rem' }}>
                  Your wallet will prompt you to review and sign the transaction.
                </p>
              </div>
            )}

            {hasWalletConnection && !psbtHex && (
              <p className="text-warning" style={{ fontSize: '0.75rem', marginBottom: '1rem' }}>
                Wallet signing is unavailable for this compose result (missing PSBT). Use QR signing instead.
              </p>
            )}

            {/* QR Code for Freewallet - Always shown as fallback or primary */}
            <div className="divider mb-2">
              <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                {canWalletSign ? 'or scan with Freewallet' : 'Scan with Freewallet Mobile'}
              </span>
            </div>

            {/* Watch-only warning */}
            {connection?.walletType === 'manual' && (
              <p className="text-warning" style={{ fontSize: '0.75rem', marginBottom: '1rem' }}>
                ⚠️ Watch-only address. Use Freewallet to sign.
              </p>
            )}

            <div className="qr-container mb-2">
              <QRCodeSVG 
                value={`counterparty:?action=signtx&tx=${txHex}`} 
                size={200}
                level="L"
                includeMargin
              />
            </div>

            <p className="text-muted" style={{ fontSize: '0.625rem', marginBottom: '1rem' }}>
              Open Freewallet app → Tools → Scan QR → Confirm to sign &amp; broadcast
            </p>

            <div style={{ textAlign: 'left', marginBottom: '1rem' }}>
              <label style={{ marginBottom: '0.25rem' }}>Track Broadcasted Tx</label>
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
                <p className="text-error" style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
                  {manualTxidError}
                </p>
              )}
            </div>

            <details style={{ textAlign: 'left', marginBottom: '1rem' }}>
              <summary className="text-muted" style={{ fontSize: '0.75rem', cursor: 'pointer' }}>
                View transaction hex
              </summary>
              <textarea
                readOnly
                value={txHex}
                style={{
                  width: '100%',
                  height: '60px',
                  fontSize: '0.625rem',
                  fontFamily: 'monospace',
                  resize: 'none',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  color: 'var(--text-muted)',
                  marginTop: '0.5rem',
                }}
              />
            </details>

            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
