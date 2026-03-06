import assert from 'node:assert/strict';
import test from 'node:test';
import { getBitcoinExplorerLabel, getBitcoinExplorerTxUrl } from '../src/lib/explorer.js';
import { setTestnet } from '../src/lib/counterparty.js';

const TEST_TXID = 'a'.repeat(64);

test('getBitcoinExplorerTxUrl uses mainnet explorer by default', () => {
  setTestnet(false);
  assert.equal(getBitcoinExplorerTxUrl(TEST_TXID), `https://mempool.space/tx/${TEST_TXID}`);
  assert.equal(getBitcoinExplorerLabel(), 'Mempool');
});

test('getBitcoinExplorerTxUrl switches to testnet explorer', () => {
  setTestnet(true);
  assert.equal(getBitcoinExplorerTxUrl(TEST_TXID), `https://mempool.space/testnet/tx/${TEST_TXID}`);
  assert.equal(getBitcoinExplorerLabel(), 'Mempool Testnet');
  setTestnet(false);
});
