import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseUnitsToInputString,
  baseUnitsToNumber,
  calculatePrice,
  displayToBaseUnits,
  formatBaseUnits,
  toBaseUnits,
} from '../src/lib/quantity.js';

test('displayToBaseUnits parses divisible values with up to 8 decimals', () => {
  assert.equal(displayToBaseUnits('1.23456789', true), 123456789n);
  assert.equal(displayToBaseUnits('0.00000001', true), 1n);
});

test('displayToBaseUnits rejects divisible values above 8 decimals', () => {
  assert.throws(
    () => displayToBaseUnits('1.000000001', true),
    /max 8 decimal places/i,
  );
});

test('displayToBaseUnits rejects decimal input for indivisible assets', () => {
  assert.equal(displayToBaseUnits('42', false), 42n);
  assert.throws(
    () => displayToBaseUnits('42.5', false),
    /indivisible/i,
  );
});

test('baseUnitsToInputString and formatBaseUnits normalize output', () => {
  assert.equal(baseUnitsToInputString(123450000n, true), '1.2345');
  assert.equal(baseUnitsToInputString(42n, false), '42');
  assert.equal(formatBaseUnits(123450000n, true), '1.2345');
  assert.equal(formatBaseUnits(4200n, false), '4,200');
});

test('calculatePrice handles mixed divisibility correctly', () => {
  // 150 XCP (divisible) for 300 units of an indivisible asset => 0.5 XCP / unit
  const price = calculatePrice(15000000000n, true, 300n, false);
  assert.equal(price, 0.5);
});

test('baseUnitsToNumber converts base units to display number', () => {
  assert.equal(baseUnitsToNumber(100000000n, true), 1);
  assert.equal(baseUnitsToNumber(7n, false), 7);
});

test('displayToBaseUnits and formatBaseUnits handle very large quantities', () => {
  const huge = displayToBaseUnits('12345678901234567890.12345678', true);
  assert.equal(huge, 1234567890123456789012345678n);
  assert.equal(formatBaseUnits(huge, true), '12,345,678,901,234,567,890.12345678');
});

test('toBaseUnits rejects unsafe JS number inputs', () => {
  assert.throws(
    () => toBaseUnits(Number.MAX_SAFE_INTEGER + 1, 'quantity'),
    /integer/i,
  );
});
