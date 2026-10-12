// The smoke user's sign-in (R6c): its password, then a code of its authenticator when the user pool asks; enrolled once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInSmoke } from './smoke-signin.mjs';
import { totp } from './totp.mjs';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const tokens = { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 };

function fakes({ enrolled, stored }) {
  const calls = [];
  const state = { enrolled, stored };
  let now = 1_700_000_000_000;
  const cognito = async (name, input) => {
    calls.push([name, input]);
    if (name === 'InitiateAuth') return state.enrolled ? { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's1' } : { AuthenticationResult: tokens };
    if (name === 'RespondToAuthChallenge') {
      if (input.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE !== totp(SECRET, now)) throw Object.assign(new Error('Invalid code'), { name: 'CodeMismatchException' });
      return { AuthenticationResult: tokens };
    }
    if (name === 'AssociateSoftwareToken') return { SecretCode: SECRET };
    if (name === 'VerifySoftwareToken') return { Status: input.UserCode === totp(SECRET, now) ? 'SUCCESS' : 'ERROR' };
    if (name === 'SetUserMFAPreference') { state.enrolled = true; return {}; }
    throw new Error(name);
  };
  const ssm = {
    get: async () => state.stored,
    put: async (value) => { calls.push(['PutParameter', value]); state.stored = value; },
  };
  const sleep = async (ms) => { now += ms; };
  return { cognito, ssm, sleep, calls, now: () => now, state };
}
const smoke = { clientId: 'c', username: 'smoke@example.invalid', password: 'p' };

test('answers the authenticator challenge with the stored secret\'s code', async () => {
  const f = fakes({ enrolled: true, stored: SECRET });
  assert.deepEqual(await signInSmoke({ smoke, ...f }), tokens);
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth', 'RespondToAuthChallenge']);
  assert.equal(f.calls[1][1].ChallengeResponses.USERNAME, 'smoke@example.invalid');
});

test('enrolls a smoke user without an authenticator once: the secret stored, then a sign-in with a code of the next step', async () => {
  const f = fakes({ enrolled: false, stored: 'none' });
  assert.deepEqual(await signInSmoke({ smoke, ...f }), tokens);
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth', 'AssociateSoftwareToken', 'VerifySoftwareToken', 'SetUserMFAPreference', 'PutParameter', 'InitiateAuth', 'RespondToAuthChallenge']);
  assert.equal(f.state.stored, SECRET);
});

test('a policy without MFA for the smoke user (optional) leaves it as it is', async () => {
  const f = fakes({ enrolled: false, stored: 'none' });
  assert.deepEqual(await signInSmoke({ smoke, ...f, enroll: false }), tokens);
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth']);
});
