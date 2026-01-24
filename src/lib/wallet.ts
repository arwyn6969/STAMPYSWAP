/**
 * Bitcoin Wallet Connector
 * Supports Leather, Xverse, and other Bitcoin browser wallets
 * that expose the window.btc provider
 * 
 * IMPORTANT: This module maintains connection state to prevent conflicts
 * between different wallet types and signing methods.
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
  walletType: WalletProvider;
}

export type WalletProvider = 'leather' | 'xverse' | 'unisat' | 'manual' | 'unknown';

// Session storage keys
const STORAGE_KEY = 'stampyswap_wallet';

// Current connection state (in-memory)
let currentConnection: WalletConnection | null = null;

/**
 * Get all installed Bitcoin wallets
 * Returns array of detected wallet types
 */
export function detectAllWallets(): WalletProvider[] {
  if (typeof window === 'undefined') return [];
  
  const wallets: WalletProvider[] = [];
  
  // @ts-expect-error - wallet provider
  if (window.LeatherProvider || window.HiroWalletProvider) {
    wallets.push('leather');
  }
  
  // @ts-expect-error - wallet provider
  if (window.XverseProviders?.BitcoinProvider) {
    wallets.push('xverse');
  }
  
  // @ts-expect-error - wallet provider
  if (window.unisat) {
    wallets.push('unisat');
  }
  
  return wallets;
}

/**
 * Get the primary detected wallet (first found)
 */
export function detectWallet(): WalletProvider | null {
  const wallets = detectAllWallets();
  return wallets.length > 0 ? wallets[0] : null;
}

/**
 * Get stored connection from session storage
 */
export function getStoredConnection(): { address: string; walletType: WalletProvider } | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Store connection in session storage
 */
function storeConnection(address: string, walletType: WalletProvider): void {
  if (typeof window === 'undefined') return;
  
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ address, walletType }));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Clear stored connection
 */
export function clearStoredConnection(): void {
  if (typeof window === 'undefined') return;
  
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  currentConnection = null;
}

/**
 * Get current in-memory connection
 */
export function getCurrentConnection(): WalletConnection | null {
  return currentConnection;
}

/**
 * Check if we can sign with the current connection
 * Returns true if we have a live wallet connection (not manual entry)
 */
export function canSign(): boolean {
  if (!currentConnection) return false;
  return currentConnection.walletType !== 'manual';
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
  
  const paymentAddr = addresses.find(a => a.purpose === 'payment') || addresses[0];
  const ordinalsAddr = addresses.find(a => a.purpose === 'ordinals') || paymentAddr;
  
  return {
    addresses,
    paymentAddress: paymentAddr.address,
    ordinalsAddress: ordinalsAddr.address,
    walletType: 'leather',
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
  const paymentAddr = addresses.find((a: BitcoinAddress) => a.purpose === 'payment') || addresses[0];
  const ordinalsAddr = addresses.find((a: BitcoinAddress) => a.purpose === 'ordinals') || paymentAddr;
  
  return {
    addresses,
    paymentAddress: paymentAddr.address,
    ordinalsAddress: ordinalsAddr.address,
    walletType: 'xverse',
  };
}

/**
 * Connect to a specific wallet type
 */
export async function connectWallet(preferredType?: WalletProvider): Promise<WalletConnection> {
  const walletType = preferredType || detectWallet();
  
  if (!walletType) {
    throw new Error('No Bitcoin wallet detected. Please install Leather or Xverse.');
  }
  
  let connection: WalletConnection;
  
  switch (walletType) {
    case 'leather':
      connection = await connectLeather();
      break;
    case 'xverse':
      connection = await connectXverse();
      break;
    default:
      throw new Error(`Wallet type "${walletType}" not yet supported`);
  }
  
  // Store connection
  currentConnection = connection;
  storeConnection(connection.paymentAddress, connection.walletType);
  
  return connection;
}

/**
 * Connect with manual address entry (watch-only, cannot sign)
 */
export function connectManual(address: string): WalletConnection {
  const connection: WalletConnection = {
    addresses: [{
      address,
      publicKey: '',
      purpose: 'payment',
      addressType: 'p2wpkh',
    }],
    paymentAddress: address,
    ordinalsAddress: address,
    walletType: 'manual',
  };
  
  currentConnection = connection;
  storeConnection(address, 'manual');
  
  return connection;
}

/**
 * Disconnect wallet
 */
export function disconnect(): void {
  currentConnection = null;
  clearStoredConnection();
}

/**
 * Sign a PSBT with the connected wallet
 * IMPORTANT: Only works if connected via wallet extension
 */
export async function signPsbt(psbtHex: string): Promise<string> {
  if (!currentConnection) {
    throw new Error('No wallet connected');
  }
  
  if (currentConnection.walletType === 'manual') {
    throw new Error('Cannot sign with manual address. Please connect with Leather or Xverse.');
  }
  
  const walletType = currentConnection.walletType;
  
  if (walletType === 'leather') {
    // @ts-expect-error - wallet provider
    const provider = window.LeatherProvider || window.HiroWalletProvider;
    if (!provider) {
      throw new Error('Leather wallet disconnected. Please reconnect.');
    }
    const response = await provider.request('signPsbt', {
      hex: psbtHex,
      broadcast: false,
    });
    return response.result.hex;
  }
  
  if (walletType === 'xverse') {
    // @ts-expect-error - wallet provider
    const provider = window.XverseProviders?.BitcoinProvider;
    if (!provider) {
      throw new Error('Xverse wallet disconnected. Please reconnect.');
    }
    const response = await provider.request('signPsbt', {
      psbt: psbtHex,
      broadcast: false,
    });
    return response.result.psbt;
  }
  
  throw new Error(`Signing not supported for wallet type: ${walletType}`);
}

/**
 * Sign and broadcast a PSBT
 * IMPORTANT: Only works if connected via wallet extension
 */
export async function signAndBroadcast(psbtHex: string): Promise<string> {
  if (!currentConnection) {
    throw new Error('No wallet connected');
  }
  
  if (currentConnection.walletType === 'manual') {
    throw new Error('Cannot sign with manual address. Use QR code with Freewallet instead.');
  }
  
  const walletType = currentConnection.walletType;
  
  if (walletType === 'leather') {
    // @ts-expect-error - wallet provider
    const provider = window.LeatherProvider || window.HiroWalletProvider;
    if (!provider) {
      throw new Error('Leather wallet disconnected. Please reconnect.');
    }
    const response = await provider.request('signPsbt', {
      hex: psbtHex,
      broadcast: true,
    });
    return response.result.txid;
  }
  
  if (walletType === 'xverse') {
    // @ts-expect-error - wallet provider
    const provider = window.XverseProviders?.BitcoinProvider;
    if (!provider) {
      throw new Error('Xverse wallet disconnected. Please reconnect.');
    }
    const response = await provider.request('signPsbt', {
      psbt: psbtHex,
      broadcast: true,
    });
    return response.result.txid;
  }
  
  throw new Error(`Broadcast not supported for wallet type: ${walletType}`);
}
