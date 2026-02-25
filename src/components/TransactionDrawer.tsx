import { type TrackedLifecycle } from '../App';

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
    <div className="fixed inset-0 z-50 pointer-events-none" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}>
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 pointer-events-auto" 
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', transition: 'opacity 0.3s' }}
        onClick={onClose}
      />
      
      {/* Drawer */}
      <div 
        className="absolute right-0 top-0 bottom-0 w-[350px] bg-base-100 shadow-2xl pointer-events-auto flex flex-col"
        style={{ 
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '350px', 
          background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-color)',
          display: 'flex', flexDirection: 'column', padding: '1.5rem', overflowY: 'auto'
        }}
      >
        <div className="flex justify-between items-center mb-4 border-b pb-2" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', margin: 0 }}>Transaction Center</h2>
          <button className="btn-icon" onClick={onClose} style={{ padding: '0.25rem 0.5rem' }}>✕</button>
        </div>

        {transactions.length === 0 ? (
          <div className="empty-state" style={{ marginTop: '2rem' }}>
            <div className="empty-state-icon">📝</div>
            <div className="empty-state-text">No recent transactions</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
             <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
               <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                 {pendingCount} {pendingCount === 1 ? 'transaction' : 'transactions'} pending
               </span>
               <button 
                 className="btn-secondary" 
                 style={{ fontSize: '0.625rem', padding: '0.25rem 0.5rem' }}
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
                <div key={tx.txid} className="card" style={{ padding: '1rem', backgroundColor: 'var(--bg-card)' }}>
                  <div className="flex justify-between items-center mb-2" style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between' }}>
                    <span className={`badge ${statusClass}`} style={{ fontSize: '0.625rem' }}>{tx.status.toUpperCase()}</span>
                    <button className="btn-icon" onClick={() => onDismiss(tx.txid)} style={{ padding: '0 0.25rem', fontSize: '0.75rem', border: 'none' }}>✕</button>
                  </div>
                  
                  <div className="text-muted mb-1" style={{ fontSize: '0.625rem', fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all', marginBottom: '0.5rem' }}>
                    {tx.txid}
                  </div>
                  
                  <div className="mb-2" style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                    {getTrackedStatusMessage(tx)}
                  </div>

                  <div className="flex justify-end gap-2" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {isPending && (
                      <button 
                        className="btn-secondary" 
                        style={{ fontSize: '0.625rem', padding: '0.25rem 0.5rem' }}
                        onClick={() => onRefresh(tx.txid)}
                      >
                        Refresh
                      </button>
                    )}
                    <a
                      className="btn-secondary"
                      href={`https://mempool.space/tx/${tx.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: '0.625rem', padding: '0.25rem 0.5rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                    >
                      Explorer
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
