import { getIsTestnet } from './counterparty.js';

export function getBitcoinExplorerTxUrl(txid: string): string {
  const normalizedTxid = txid.trim();
  if (getIsTestnet()) {
    return `https://mempool.space/testnet/tx/${normalizedTxid}`;
  }
  return `https://mempool.space/tx/${normalizedTxid}`;
}

export function getBitcoinExplorerLabel(): string {
  return getIsTestnet() ? 'Mempool Testnet' : 'Mempool';
}
