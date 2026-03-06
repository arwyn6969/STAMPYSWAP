import { type TrackedLifecycle } from '../App';
import { getBitcoinExplorerLabel, getBitcoinExplorerTxUrl } from '../lib/explorer';

export interface TrackedTransaction {
  txid: string;
  status: TrackedLifecycle;
  confirmations: number;
  source?: string;
  lastChecked: Date | null;
  error: string | null;
}

interface TransactionDrawerProps {
  transactions: TrackedTransaction[];
  isOpen: boolean;
  onClose: () => void;
  onRefresh: (txid: string) => void;
  onDismiss: (txid: string) => void;
  onClearCompleted: () => void;
}

export function TransactionDrawer({ 
  transactions, 
  isOpen, 
  onClose, 
  onRefresh, 
  onDismiss,
  onClearCompleted
}: TransactionDrawerProps) {
  
  if (!isOpen) return null;

  const getTrackedStatusMessage = (tx: TrackedTransaction): string => {
    if (tx.status === 'confirmed') {
      const suffix = tx.confirmations === 1 ? '' : 's';
      return `Confirmed (${tx.confirmations} confirmation${suffix}).`;
    }
    if (tx.status === 'mempool') {
      return 'In mempool. Waiting for first confirmation.';
    }
    if (tx.status === 'failed') {
      return 'Transaction appears rejected or dropped.';
    }
    if (tx.status === 'unknown') {
      return 'Broadcasted, but network status is unknown.';
    }
    return 'Broadcasted. Waiting for mempool visibility.';
  };

  const pendingCount = transactions.filter(t => t.status !== 'confirmed' && t.status !== 'failed').length;

  return (
    <div className="app-overlay">
      <div className="app-backdrop" onClick={onClose} />
      <aside className="app-drawer" aria-label="Transaction Center">
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">Transaction Center</h2>
            <p className="drawer-subtitle">Monitor pending broadcasts and jump to the correct network explorer.</p>
          </div>
          <button className="btn-icon drawer-close-btn" type="button" onClick={onClose}>✕</button>
        </div>

        {transactions.length === 0 ? (
          <div className="empty-state drawer-empty-state">
            <div className="empty-state-icon">📝</div>
            <div className="empty-state-text">No recent transactions</div>
          </div>
        ) : (
          <div className="drawer-content">
             <div className="drawer-toolbar">
               <span className="drawer-toolbar-copy text-muted">
                 {pendingCount} {pendingCount === 1 ? 'transaction' : 'transactions'} pending
               </span>
               <button 
                 type="button"
                 className="btn-secondary drawer-toolbar-btn"
                 onClick={onClearCompleted}
               >
                 Clear Completed
               </button>
             </div>

            {transactions.map(tx => {
              const statusClass = tx.status === 'confirmed' 
                ? 'badge-success' 
                : tx.status === 'failed' 
                  ? 'text-error' 
                  : 'badge-primary';
              
              const isPending = tx.status !== 'confirmed' && tx.status !== 'failed';

              return (
                <div key={tx.txid} className="drawer-status-card">
                  <div className="drawer-status-top">
                    <span className={`badge ${statusClass}`}>{tx.status.toUpperCase()}</span>
                    <button className="btn-icon drawer-dismiss-btn" type="button" onClick={() => onDismiss(tx.txid)}>✕</button>
                  </div>
                  
                  <div className="drawer-txid text-muted">
                    {tx.txid}
                  </div>
                  
                  <div className="drawer-status-message">
                    {getTrackedStatusMessage(tx)}
                  </div>
                  {tx.error && (
                    <div className="drawer-error text-error">
                      {tx.error}
                    </div>
                  )}

                  <div className="drawer-status-actions">
                    {isPending && (
                      <button 
                        type="button"
                        className="btn-secondary drawer-toolbar-btn"
                        onClick={() => onRefresh(tx.txid)}
                      >
                        Refresh
                      </button>
                    )}
                    <a
                      href={getBitcoinExplorerTxUrl(tx.txid)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary drawer-link-btn"
                    >
                      {getBitcoinExplorerLabel()}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
