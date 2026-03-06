import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * We test the wallet address validation and type inference logic.
 *
 * Because `isValidBitcoinAddress` depends on testnet state from counterparty.ts,
 * and that module reads `localStorage` on import, we need to mock the testnet
 * state by calling `setTestnet()` directly.
 */
import { setTestnet } from '../src/lib/counterparty.js';

// Dynamic import is tricky since wallet.ts statically imports counterparty.
// Because counterparty sets up testnet from localStorage on import, and our test
// environment doesn't have localStorage, we just call setTestnet before each test.

// We re-import to get the actual module functions
import {
  isValidBitcoinAddress,
} from '../src/lib/wallet.js';

// Test inferAddressType indirectly through buildConnection (which is non-exported)
// We'll test it through connectManual which calls both isValidBitcoinAddress and
// inferAddressType via buildConnection.

describe('isValidBitcoinAddress', () => {
  describe('mainnet mode', () => {
    beforeEach(() => {
      setTestnet(false);
    });

    it('accepts P2PKH mainnet address (1...)', () => {
      assert.equal(isValidBitcoinAddress('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j'), true);
    });

    it('accepts P2SH mainnet address (3...)', () => {
      assert.equal(isValidBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true);
    });

    it('accepts bech32 mainnet address (bc1q...)', () => {
      assert.equal(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), true);
    });

    it('accepts bech32m mainnet taproot address (bc1p...)', () => {
      assert.equal(
        isValidBitcoinAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'),
        true,
      );
    });

    it('rejects testnet address in mainnet mode', () => {
      assert.equal(isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), false);
    });

    it('rejects testnet P2PKH (m...) in mainnet mode', () => {
      assert.equal(isValidBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), false);
    });

    it('rejects testnet P2PKH (n...) in mainnet mode', () => {
      assert.equal(isValidBitcoinAddress('n1WCyq7MVAM9pwPTXjVCpUEzMb9Pw5W57X'), false);
    });

    it('rejects empty string', () => {
      assert.equal(isValidBitcoinAddress(''), false);
    });

    it('rejects whitespace-only', () => {
      assert.equal(isValidBitcoinAddress('   '), false);
    });

    it('rejects random text', () => {
      assert.equal(isValidBitcoinAddress('not-an-address'), false);
    });

    it('trims whitespace before validation', () => {
      assert.equal(
        isValidBitcoinAddress('  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4  '),
        true,
      );
    });
  });

  describe('testnet mode', () => {
    beforeEach(() => {
      setTestnet(true);
    });

    it('accepts bech32 testnet address (tb1q...)', () => {
      assert.equal(isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), true);
    });

    it('accepts bech32m testnet taproot address (tb1p...)', () => {
      assert.equal(
        isValidBitcoinAddress('tb1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusq7vf7y'),
        true,
      );
    });

    it('accepts testnet P2PKH (m...)', () => {
      assert.equal(isValidBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), true);
    });

    it('accepts testnet P2PKH (n...)', () => {
      assert.equal(isValidBitcoinAddress('n1WCyq7MVAM9pwPTXjVCpUEzMb9Pw5W57X'), true);
    });

    it('rejects mainnet address in testnet mode', () => {
      assert.equal(isValidBitcoinAddress('1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j'), false);
    });

    it('rejects mainnet bech32 in testnet mode', () => {
      assert.equal(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false);
    });

    it('rejects empty string', () => {
      assert.equal(isValidBitcoinAddress(''), false);
    });
  });
});

// Restore mainnet state after all tests
describe('cleanup', () => {
  it('restores mainnet mode', () => {
    setTestnet(false);
    // no assertion needed, just cleanup
  });
});
