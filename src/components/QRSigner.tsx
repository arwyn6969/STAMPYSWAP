import { QRCodeSVG } from 'qrcode.react';
import type { ComposeResult } from '../lib/counterparty';

interface QRSignerProps {
  composeResult: ComposeResult | null;
  onClose: () => void;
}

export function QRSigner({ composeResult, onClose }: QRSignerProps) {
  if (!composeResult) return null;

  const txHex = composeResult.rawtransaction;

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
        <h2>Sign with Freewallet</h2>
        <p className="text-muted mb-2">
          Scan this QR code with Freewallet to sign and broadcast the transaction.
        </p>

        <div className="qr-container mb-2">
          <QRCodeSVG 
            value={txHex} 
            size={256}
            level="L"
            includeMargin
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label>Transaction Hex</label>
          <textarea
            readOnly
            value={txHex}
            style={{
              width: '100%',
              height: '80px',
              fontSize: '0.625rem',
              fontFamily: 'monospace',
              resize: 'none',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '0.5rem',
              color: 'var(--text-muted)',
            }}
          />
        </div>

        <p className="text-warning" style={{ fontSize: '0.75rem', marginBottom: '1rem' }}>
          ⏱️ This code expires in 60 seconds
        </p>

        <button className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
