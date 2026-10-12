// The smoke user's sign-in (R6c): its password, then a code of its authenticator when the user pool asks; enrolled once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInSmoke } from './smoke-signin.mjs';
import { totp } from './totp.mjs';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const tokens = { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 };

function fakes({ enrolled, stored, used = false, setup = false }) {
  const calls = [];
  const state = { enrolled, stored, used, setup };
  let now = 1_700_000_000_000;
  const cognito = async (name, input) => {
    calls.push([name, input]);
    if (name === 'InitiateAuth') {
      if (state.setup && !state.enrolled) return { ChallengeName: 'MFA_SETUP', Session: 'setup-1' };
      return state.enrolled ? { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's1' } : { AuthenticationResult: tokens };
    }
    if (name === 'RespondToAuthChallenge' && input.ChallengeName === 'MFA_SETUP') {
      state.enrolled = true;
      return { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's2' };
    }
    if (name === 'RespondToAuthChallenge') {
      if (state.used) {
        state.used = false;
        throw Object.assign(new Error('Your software token has already been used once.'), { name: 'ExpiredCodeException' });
      }
      if (input.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE !== totp(SECRET, now)) throw Object.assign(new Error('Invalid code'), { name: 'CodeMismatchException' });
      return { AuthenticationResult: tokens };
    }
    if (name === 'AssociateSoftwareToken') return { SecretCode: SECRET };
    if (name === 'VerifySoftwareToken') return { Status: input.UserCode === totp(SECRET, now) ? 'SUCCESS' : 'ERROR', ...(input.Session ? { Session: 'verified-1' } : {}) };
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
  // Review M7: the secret is stored before it is verified (a failure after that leaves it known).
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth', 'AssociateSoftwareToken', 'PutParameter', 'VerifySoftwareToken', 'SetUserMFAPreference', 'InitiateAuth', 'RespondToAuthChallenge']);
  assert.equal(f.state.stored, SECRET);
});

test('a policy without MFA for the smoke user (optional) leaves it as it is', async () => {
  const f = fakes({ enrolled: false, stored: 'none' });
  assert.deepEqual(await signInSmoke({ smoke, ...f, enroll: false }), tokens);
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth']);
});

test('a code already used (a sign-in a moment ago) waits for the next one, once', async () => {
  const f = fakes({ enrolled: true, stored: SECRET, used: true });
  const before = f.now();
  assert.deepEqual(await signInSmoke({ smoke, ...f }), tokens);
  assert.deepEqual(f.calls.map(([name]) => name), ['InitiateAuth', 'RespondToAuthChallenge', 'InitiateAuth', 'RespondToAuthChallenge']);
  assert.ok(Math.floor(f.now() / 30_000) > Math.floor(before / 30_000), 'the next 30-second step');
});

test('review M7: a secret stored for a user no longer asked for a code (reset) is replaced by a new enrollment', async () => {
  const f = fakes({ enrolled: false, stored: 'OLDSECRET' });
  assert.deepEqual(await signInSmoke({ smoke, ...f }), tokens);
  assert.ok(f.calls.some(([name]) => name === 'AssociateSoftwareToken'));
  assert.equal(f.state.stored, SECRET);
});

test('review I3: under required, a smoke user never enrolled answers MFA_SETUP with a new authenticator', async () => {
  const f = fakes({ enrolled: false, stored: 'none', setup: true });
  assert.deepEqual(await signInSmoke({ smoke, ...f }), tokens);
  const names = f.calls.map(([name, input]) => (name === 'RespondToAuthChallenge' ? `${name}:${input.ChallengeName}` : name));
  assert.deepEqual(names, ['InitiateAuth', 'AssociateSoftwareToken', 'PutParameter', 'VerifySoftwareToken', 'RespondToAuthChallenge:MFA_SETUP', 'RespondToAuthChallenge:SOFTWARE_TOKEN_MFA']);
  assert.deepEqual(f.calls[1][1], { Session: 'setup-1' });
  assert.equal(f.state.stored, SECRET);
});
