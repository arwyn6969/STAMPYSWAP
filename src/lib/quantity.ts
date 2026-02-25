const DIVISIBLE_SCALE = 100000000n;

export type BaseUnits = bigint;

function formatGroupedDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function parseIntegerString(value: string, label: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return BigInt(value);
}

export function toBaseUnits(value: bigint | number | string, label = 'quantity'): BaseUnits {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return parseIntegerString(trimmed, label);
}

export function minBaseUnits(a: BaseUnits, b: BaseUnits): BaseUnits {
  return a < b ? a : b;
}

export function scaleBaseUnitsFloor(
  amount: BaseUnits,
  numerator: BaseUnits,
  denominator: BaseUnits,
): BaseUnits {
  if (denominator <= 0n) {
    throw new Error('Denominator must be positive');
  }
  return (amount * numerator) / denominator;
}

export function baseUnitsToNumber(value: bigint | number, divisible: boolean): number {
  const units = toBaseUnits(value, 'quantity');
  if (!divisible) return Number(units);
  return Number(units) / Number(DIVISIBLE_SCALE);
}

export function formatBaseUnits(value: bigint | number, divisible: boolean): string {
  const units = toBaseUnits(value, 'quantity');
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const sign = negative ? '-' : '';

  if (!divisible) {
    return `${sign}${formatGroupedDigits(absolute.toString())}`;
  }

  const whole = absolute / DIVISIBLE_SCALE;
  const fraction = (absolute % DIVISIBLE_SCALE).toString().padStart(8, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const wholeFormatted = formatGroupedDigits(whole.toString());
  if (!trimmedFraction) {
    return `${sign}${wholeFormatted}`;
  }
  return `${sign}${wholeFormatted}.${trimmedFraction}`;
}

export function baseUnitsToInputString(value: bigint | number, divisible: boolean): string {
  const units = toBaseUnits(value, 'quantity');
  if (!divisible) {
    return units.toString();
  }

  const absolute = units < 0n ? -units : units;
  const whole = absolute / DIVISIBLE_SCALE;
  const fraction = (absolute % DIVISIBLE_SCALE).toString().padStart(8, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const sign = units < 0n ? '-' : '';
  if (!trimmedFraction) {
    return `${sign}${whole.toString()}`;
  }
  return `${sign}${whole.toString()}.${trimmedFraction}`;
}

export function displayToBaseUnits(value: string, divisible: boolean): BaseUnits {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Quantity is required');
  }

  if (!divisible) {
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('This asset is indivisible and only supports whole numbers');
    }
    return BigInt(trimmed);
  }

  const match = trimmed.match(/^(\d+)(?:\.(\d{0,8}))?$/);
  if (!match) {
    throw new Error('Invalid quantity format (max 8 decimal places)');
  }

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(8, '0');
  const fractionUnits = BigInt(fraction || '0');
  return whole * DIVISIBLE_SCALE + fractionUnits;
}

export function calculatePrice(
  quoteQuantityBaseUnits: bigint | number,
  quoteDivisible: boolean,
  baseQuantityBaseUnits: bigint | number,
  baseDivisible: boolean,
): number {
  const quote = baseUnitsToNumber(quoteQuantityBaseUnits, quoteDivisible);
  const base = baseUnitsToNumber(baseQuantityBaseUnits, baseDivisible);
  if (base <= 0) return 0;
  return quote / base;
}
