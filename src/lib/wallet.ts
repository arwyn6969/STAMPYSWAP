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

interface StoredWalletConnection {
  address: string;
  walletType: WalletProvider;
}

// Session storage keys
const STORAGE_KEY = 'stampyswap_wallet';
const MAINNET_ADDRESS_REGEX = /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

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
  
  return wallets;
}

function isWalletProviderAvailable(walletType: WalletProvider): boolean {
  if (typeof window === 'undefined') return false;
  if (walletType === 'leather') {
    // @ts-expect-error - wallet provider
    return Boolean(window.LeatherProvider || window.HiroWalletProvider);
  }
  if (walletType === 'xverse') {
    // @ts-expect-error - wallet provider
    return Boolean(window.XverseProviders?.BitcoinProvider);
  }
  return false;
}

/**
 * Get the primary detected wallet (first found)
 */
export function detectWallet(): WalletProvider | null {
  const wallets = detectAllWallets();
  return wallets.length > 0 ? wallets[0] : null;
}

function isStoredWalletConnection(value: unknown): value is StoredWalletConnection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const walletType = record.walletType;
  return (
    typeof record.address === 'string' &&
    (walletType === 'leather' ||
      walletType === 'xverse' ||
      walletType === 'unisat' ||
      walletType === 'manual' ||
      walletType === 'unknown')
  );
}

function inferAddressType(address: string): BitcoinAddress['addressType'] {
  if (address.startsWith('bc1p')) return 'p2tr';
  if (address.startsWith('bc1')) return 'p2wpkh';
  if (address.startsWith('3')) return 'p2sh';
  return 'p2pkh';
}

function buildConnection(address: string, walletType: WalletProvider): WalletConnection {
  const normalizedAddress = address.trim();
  const addressType = inferAddressType(normalizedAddress);
  return {
    addresses: [{
      address: normalizedAddress,
      publicKey: '',
      purpose: 'payment',
      addressType,
    }],
    paymentAddress: normalizedAddress,
    ordinalsAddress: normalizedAddress,
    walletType,
  };
}

/**
 * Get stored connection from session storage
 */
export function getStoredConnection(): StoredWalletConnection | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (isStoredWalletConnection(parsed)) {
        return parsed;
      }
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
 * Restore an in-memory connection from session storage.
 * Manual connections can always be restored. Extension wallets are restored
 * only when the matching provider is currently available.
 */
export function restoreStoredConnection(): WalletConnection | null {
  const stored = getStoredConnection();
  if (!stored) return null;

  if (!isValidBitcoinAddress(stored.address)) {
    clearStoredConnection();
    return null;
  }

  if (stored.walletType !== 'manual' && !isWalletProviderAvailable(stored.walletType)) {
    clearStoredConnection();
    return null;
  }

  const restored = buildConnection(stored.address, stored.walletType);
  currentConnection = restored;
  return restored;
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

export function isValidBitcoinAddress(address: string): boolean {
  const trimmed = address.trim();
  return MAINNET_ADDRESS_REGEX.test(trimmed);
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
  if (!isValidBitcoinAddress(address)) {
    throw new Error('Invalid Bitcoin mainnet address');
  }

  const connection = buildConnection(address, 'manual');
  
  currentConnection = connection;
  storeConnection(connection.paymentAddress, 'manual');
  
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
