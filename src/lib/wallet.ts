/**
 * Bitcoin Wallet Connector
 * Supports Leather, Xverse, and other Bitcoin browser wallets
 * that expose the window.btc provider
 */

export interface BitcoinAddress {
  address: string;
  publicKey: string;
  purpose: 'payment' | 'ordinals' | 'stacks';
  addressType: 'p2wpkh' | 'p2tr' | 'p2sh' | 'p2pkh';
}

export interface WalletConnection {
  addresses: BitcoinAddress[];
  paymentAddress: string;
  ordinalsAddress: string;
}

export type WalletProvider = 'leather' | 'xverse' | 'unisat' | 'unknown';

// Check if a Bitcoin wallet is installed
export function detectWallet(): WalletProvider | null {
  if (typeof window === 'undefined') return null;
  
  // Check for Leather (formerly Hiro Wallet)
  // @ts-expect-error - wallet provider
  if (window.LeatherProvider || window.HiroWalletProvider) {
    return 'leather';
  }
  
  // Check for Xverse
  // @ts-expect-error - wallet provider
  if (window.XverseProviders?.BitcoinProvider) {
    return 'xverse';
  }
  
  // Check for Unisat
  // @ts-expect-error - wallet provider
  if (window.unisat) {
    return 'unisat';
  }
  
  // Generic BTC provider check
  // @ts-expect-error - wallet provider
  if (window.btc) {
    return 'unknown';
  }
  
  return null;
}

// Connect to Leather wallet
async function connectLeather(): Promise<WalletConnection> {
  // @ts-expect-error - wallet provider
  const provider = window.LeatherProvider || window.HiroWalletProvider;
  if (!provider) {
    throw new Error('Leather wallet not found');
  }
  
  const response = await provider.request('getAddresses');
  
  if (!response.result?.addresses?.length) {
    throw new Error('No addresses returned from Leather');
  }
  
  const addresses: BitcoinAddress[] = response.result.addresses.map((addr: { address: string; publicKey: string; purpose: string; type: string }) => ({
    address: addr.address,
    publicKey: addr.publicKey,
    purpose: addr.purpose as 'payment' | 'ordinals' | 'stacks',
    addressType: addr.type as 'p2wpkh' | 'p2tr' | 'p2sh' | 'p2pkh',
  }));
  
  // Find payment address (SegWit preferred) and ordinals address (Taproot)
  const paymentAddr = addresses.find(a => a.purpose === 'payment') || addresses[0];
  const ordinalsAddr = addresses.find(a => a.purpose === 'ordinals') || paymentAddr;
  
  return {
    addresses,
    paymentAddress: paymentAddr.address,
    ordinalsAddress: ordinalsAddr.address,
  };
}

// Connect to Xverse wallet
async function connectXverse(): Promise<WalletConnection> {
  // @ts-expect-error - wallet provider
  const provider = window.XverseProviders?.BitcoinProvider;
  if (!provider) {
    throw new Error('Xverse wallet not found');
  }
  
  const response = await provider.request('getAddresses', {
    purposes: ['payment', 'ordinals'],
    message: 'STAMPYSWAP needs access to your Bitcoin addresses',
  });
  
  if (!response.result?.addresses?.length) {
    throw new Error('No addresses returned from Xverse');
  }
  
  const addresses: BitcoinAddress[] = response.result.addresses;
  const paymentAddr = addresses.find(a => a.purpose === 'payment') || addresses[0];
  const ordinalsAddr = addresses.find(a => a.purpose === 'ordinals') || paymentAddr;
  
  return {
    addresses,
    paymentAddress: paymentAddr.address,
    ordinalsAddress: ordinalsAddr.address,
  };
}

// Connect to any detected wallet
export async function connectWallet(): Promise<WalletConnection> {
  const walletType = detectWallet();
  
  if (!walletType) {
    throw new Error('No Bitcoin wallet detected. Please install Leather or Xverse.');
  }
  
  switch (walletType) {
    case 'leather':
      return connectLeather();
    case 'xverse':
      return connectXverse();
    default:
      throw new Error(`Wallet type "${walletType}" not yet supported`);
  }
}

// Sign a PSBT with the connected wallet
export async function signPsbt(psbtHex: string): Promise<string> {
  const walletType = detectWallet();
  
  if (!walletType) {
    throw new Error('No wallet connected');
  }
  
  if (walletType === 'leather') {
    // @ts-expect-error - wallet provider
    const provider = window.LeatherProvider || window.HiroWalletProvider;
    const response = await provider.request('signPsbt', {
      hex: psbtHex,
      broadcast: false, // We'll broadcast ourselves
    });
    return response.result.hex;
  }
  
  if (walletType === 'xverse') {
    // @ts-expect-error - wallet provider
    const provider = window.XverseProviders?.BitcoinProvider;
    const response = await provider.request('signPsbt', {
      psbt: psbtHex,
      broadcast: false,
    });
    return response.result.psbt;
  }
  
  throw new Error(`Signing not supported for wallet type: ${walletType}`);
}

// Sign and broadcast a PSBT
export async function signAndBroadcast(psbtHex: string): Promise<string> {
  const walletType = detectWallet();
  
  if (!walletType) {
    throw new Error('No wallet connected');
  }
  
  if (walletType === 'leather') {
    // @ts-expect-error - wallet provider
    const provider = window.LeatherProvider || window.HiroWalletProvider;
    const response = await provider.request('signPsbt', {
      hex: psbtHex,
      broadcast: true,
    });
    return response.result.txid;
  }
  
  if (walletType === 'xverse') {
    // @ts-expect-error - wallet provider
    const provider = window.XverseProviders?.BitcoinProvider;
    const response = await provider.request('signPsbt', {
      psbt: psbtHex,
      broadcast: true,
    });
    return response.result.txid;
  }
  
  throw new Error(`Broadcast not supported for wallet type: ${walletType}`);
}
