// Project-owned, bounded, pure JavaScript replacement for bigint-buffer. No native bindings.
'use strict'
const MAX_BYTES = 4096
function bytes(value) {
  if (!Buffer.isBuffer(value) || value.length > MAX_BYTES) throw new RangeError('invalid bigint buffer')
  return value
}
function toBigIntBE(buffer) {
  bytes(buffer)
  let value = 0n
  for (const byte of buffer) value = (value << 8n) | BigInt(byte)
  return value
}
function toBigIntLE(buffer) {
  bytes(buffer)
  let value = 0n
  for (let i = buffer.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(buffer[i])
  return value
}
function encode(value, width, littleEndian) {
  if (typeof value !== 'bigint' || value < 0n || !Number.isSafeInteger(width) || width < 0 || width > MAX_BYTES)
    throw new RangeError('invalid unsigned bigint or buffer width')
  if (value >> BigInt(width * 8)) throw new RangeError('unsigned bigint exceeds buffer width')
  const buffer = Buffer.alloc(width)
  for (let i = 0; i < width; i++) {
    buffer[littleEndian ? i : width - i - 1] = Number(value & 255n)
    value >>= 8n
  }
  return buffer
}
module.exports = { toBigIntBE, toBigIntLE, toBufferBE: (v, w) => encode(v, w, false), toBufferLE: (v, w) => encode(v, w, true) }
