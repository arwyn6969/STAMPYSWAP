/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { getTransactionStatus } from '../lib/counterparty';
import { type TrackedTransaction } from '../components/TransactionDrawer';

interface TransactionContextValue {
  trackedTxs: TrackedTransaction[];
  isDrawerOpen: boolean;
  pendingCount: number;
  openDrawer: () => void;
  closeDrawer: () => void;
  broadcast: (txid: string) => void;
  refreshTx: (txid: string) => Promise<void>;
  dismissTx: (txid: string) => void;
  clearCompleted: () => void;
}

const TransactionContext = createContext<TransactionContextValue | null>(null);

export function TransactionProvider({
  children,
  onConfirmed,
  onBroadcast,
}: {
  children: ReactNode;
  onConfirmed?: () => void;
  onBroadcast?: () => void;
}) {
  const [trackedTxs, setTrackedTxs] = useState<TrackedTransaction[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const broadcast = useCallback((txid: string) => {
    setTrackedTxs(prev => {
      if (prev.some(t => t.txid === txid)) return prev;
      return [{
        txid,
        status: 'broadcasted',
        confirmations: 0,
        lastChecked: new Date(),
        error: null,
      }, ...prev];
    });
    setIsDrawerOpen(true);
    onBroadcast?.();
  }, [onBroadcast]);

  const refreshTx = useCallback(async (txid: string) => {
    try {
      const state = await getTransactionStatus(txid);
      setTrackedTxs(prev => prev.map(tx => {
        if (tx.txid !== txid) return tx;
        return {
          ...tx,
          status: state.status,
          confirmations: state.confirmations,
          source: state.source,
          lastChecked: new Date(),
          error: null,
        };
      }));

      if (state.status === 'confirmed') {
        onConfirmed?.();
      }
    } catch (err) {
      setTrackedTxs(prev => prev.map(tx => {
        if (tx.txid !== txid) return tx;
        return {
          ...tx,
          lastChecked: new Date(),
          error: err instanceof Error ? err.message : 'Unable to refresh transaction status',
        };
      }));
    }
  }, [onConfirmed]);

  // Auto-poll pending transactions
  useEffect(() => {
    const pendingTxs = trackedTxs.filter(tx => tx.status !== 'confirmed' && tx.status !== 'failed');
    if (pendingTxs.length === 0) return;

    for (const tx of pendingTxs) {
      void refreshTx(tx.txid);
    }

    const timerId = window.setInterval(() => {
      for (const tx of pendingTxs) {
        void refreshTx(tx.txid);
      }
    }, 15000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [trackedTxs, refreshTx]);

  const dismissTx = useCallback((txid: string) => {
    setTrackedTxs(prev => prev.filter(tx => tx.txid !== txid));
  }, []);

  const clearCompleted = useCallback(() => {
    setTrackedTxs(prev => prev.filter(tx => tx.status !== 'confirmed' && tx.status !== 'failed'));
  }, []);

  const pendingCount = trackedTxs.filter(t => t.status !== 'confirmed' && t.status !== 'failed').length;

  return (
    <TransactionContext.Provider
      value={{
        trackedTxs,
        isDrawerOpen,
        pendingCount,
        openDrawer: useCallback(() => setIsDrawerOpen(true), []),
        closeDrawer: useCallback(() => setIsDrawerOpen(false), []),
        broadcast,
        refreshTx,
        dismissTx,
        clearCompleted,
      }}
    >
      {children}
    </TransactionContext.Provider>
  );
}

export function useTransactions(): TransactionContextValue {
  const ctx = useContext(TransactionContext);
  if (!ctx) throw new Error('useTransactions must be used within a TransactionProvider');
  return ctx;
}
