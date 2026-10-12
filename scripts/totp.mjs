// TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as Cognito checks them: the smoke user's authenticator (R6c).
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(text) {
  let bits = '';
  for (const c of text.replace(/[\s=]/g, '').toUpperCase()) {
    const value = ALPHABET.indexOf(c);
    if (value < 0) throw new Error(`not base32: ${c}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
