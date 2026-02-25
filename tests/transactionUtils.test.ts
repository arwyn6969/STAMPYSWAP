import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTxid, isValidTxid } from '../src/lib/transaction.js';

const SAMPLE_TXID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('isValidTxid accepts canonical txids', () => {
  assert.equal(isValidTxid(SAMPLE_TXID), true);
  assert.equal(isValidTxid(SAMPLE_TXID.toUpperCase()), true);
});

test('isValidTxid rejects malformed txids', () => {
  assert.equal(isValidTxid(''), false);
  assert.equal(isValidTxid('1234'), false);
  assert.equal(isValidTxid(`${SAMPLE_TXID}00`), false);
  assert.equal(isValidTxid(SAMPLE_TXID.replace('f', 'z')), false);
});

test('extractTxid returns normalized txid from raw input', () => {
  assert.equal(extractTxid(SAMPLE_TXID.toUpperCase()), SAMPLE_TXID);
});

test('extractTxid extracts txid from explorer URLs or free-form strings', () => {
  const url = `https://mempool.space/tx/${SAMPLE_TXID}`;
  assert.equal(extractTxid(url), SAMPLE_TXID);
  assert.equal(extractTxid(`tx was ${SAMPLE_TXID} just now`), SAMPLE_TXID);
});

test('extractTxid returns null when no txid is present', () => {
  assert.equal(extractTxid('not-a-txid'), null);
  assert.equal(extractTxid(''), null);
});
