// TOTP codes (RFC 6238) for the smoke user's authenticator (R6c): the RFC's SHA-1 test vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32, totp } from './totp.mjs';

// The RFC's key, "12345678901234567890", as Cognito would give it: base32.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 decodes a Cognito secret', () => {
  assert.equal(base32(SECRET).toString('ascii'), '12345678901234567890');
  assert.equal(base32('gezd gnbv').toString('ascii'), '12345');
});

test('codes of the RFC 6238 test vectors (SHA-1, 30 s, 6 digits)', () => {
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(totp(SECRET, seconds * 1000), code, String(seconds));
  }
});
