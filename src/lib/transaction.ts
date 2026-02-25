const TXID_REGEX = /^[a-fA-F0-9]{64}$/;

/**
 * Returns true when input is a valid 64-char hexadecimal txid.
 */
export function isValidTxid(value: string): boolean {
  return TXID_REGEX.test(value.trim());
}

/**
 * Tries to extract a txid from free-form input.
 * Accepts either a raw txid or any string containing one (e.g. explorer URL).
 */
export function extractTxid(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isValidTxid(trimmed)) {
    return trimmed.toLowerCase();
  }

  const match = trimmed.match(/[a-fA-F0-9]{64}/);
  if (!match) return null;
  return match[0].toLowerCase();
}
