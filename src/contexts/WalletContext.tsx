/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface WalletContextValue {
  userAddress: string;
  walletCanSign: boolean;
  connect: (address: string, canSign?: boolean) => void;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children, onDisconnect }: { children: ReactNode; onDisconnect?: () => void }) {
  const [userAddress, setUserAddress] = useState('');
  const [walletCanSign, setWalletCanSign] = useState(false);

  const connect = useCallback((address: string, canSign = false) => {
    setUserAddress(address);
    setWalletCanSign(canSign);
  }, []);

  const disconnect = useCallback(() => {
    setUserAddress('');
    setWalletCanSign(false);
    onDisconnect?.();
  }, [onDisconnect]);

  return (
    <WalletContext.Provider value={{ userAddress, walletCanSign, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within a WalletProvider');
  return ctx;
}
