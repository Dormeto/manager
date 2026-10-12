// The smoke user's sign-in (R6c): its password, then a code of its authenticator app when the user pool asks for one.
// Under the operators or required MFA policy the smoke user (an administrator) needs one: enrolled once, its secret kept
// in SSM (/dmt-<env>/manager/smoke-totp).
import { totp } from './totp.mjs';

const STEP_MS = 30_000;

// cognito(name, input): a Cognito user pools call; ssm: { get(), put(value) } of the secret's parameter ('none' until
// enrolled); enroll: false leaves a user without an authenticator as it is (policy optional).
export async function signInSmoke({ smoke, cognito, ssm, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, enroll = true }) {
  const nextStep = () => sleep(STEP_MS - (now() % STEP_MS) + 1000);
  const code = async () => {
    const secret = await ssm.get();
    if (!secret || secret === 'none') throw new Error('smoke sign-in: an authenticator is set up but its secret is not in SSM (reset the smoke user\'s MFA)');
    return totp(secret, now());
  };
  // A new authenticator, with an access token (enrolling a signed-in user) or the session of an MFA_SETUP challenge
  // (required): its secret stored before it is verified, so that a failure after that leaves it known.
  const associate = async (auth) => {
    const { SecretCode, Session } = await cognito('AssociateSoftwareToken', auth);
    await ssm.put(SecretCode);
    const verified = await cognito('VerifySoftwareToken', { ...(Session ? { Session } : auth), UserCode: totp(SecretCode, now()), FriendlyDeviceName: 'smoke' });
    if (verified.Status !== 'SUCCESS') throw new Error('smoke sign-in: the authenticator code was refused');
    return verified;
  };
  // A challenge answered until tokens come: the authenticator's code (a code is accepted once: one just used means the
  // next one), or a first authenticator (MFA_SETUP, under required).
  async function answer(out, retried = false) {
    if (out.AuthenticationResult) return out;
    if (out.ChallengeName === 'MFA_SETUP') {
      const { Session } = await associate({ Session: out.Session });
      await nextStep();
      return answer(await cognito('RespondToAuthChallenge', { ClientId: smoke.clientId, ChallengeName: 'MFA_SETUP', Session, ChallengeResponses: { USERNAME: smoke.username } }));
    }
    if (out.ChallengeName !== 'SOFTWARE_TOKEN_MFA') throw new Error(`smoke sign-in: unexpected challenge ${out.ChallengeName}`);
    try {
      return await cognito('RespondToAuthChallenge', {
        ClientId: smoke.clientId, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: out.Session,
        ChallengeResponses: { USERNAME: smoke.username, SOFTWARE_TOKEN_MFA_CODE: await code() },
      });
    } catch (err) {
      if (retried || err.name !== 'ExpiredCodeException') throw err;
      await nextStep();
      return answer(await initiate(), true);
    }
  }
  const initiate = () => cognito('InitiateAuth', { ClientId: smoke.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: smoke.username, PASSWORD: smoke.password } });
  const challenged = { value: false };
  const signIn = async () => {
    const out = await initiate();
    challenged.value = !out.AuthenticationResult;
    return (await answer(out)).AuthenticationResult;
  };
  const tokens = await signIn();
  // Asked for a code: enrolled. Not asked (policy optional, or a reset), and enrolling: a new authenticator, whatever
  // secret SSM still holds.
  if (challenged.value || !enroll) return tokens;
  await associate({ AccessToken: tokens.AccessToken });
  await cognito('SetUserMFAPreference', { AccessToken: tokens.AccessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } });
  await nextStep();
  return signIn();
}

// The smoke user's tokens for a deployed environment: its credentials and secret in SSM, the calls through the SDK.
export async function smokeTokens({ env, region, credentials }) {
  const { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand, AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand, SetUserMFAPreferenceCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const { GetParameterCommand, PutParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm');
  const ssmClient = new SSMClient({ region, credentials });
  const smoke = JSON.parse((await ssmClient.send(new GetParameterCommand({ Name: `/dmt-${env}/manager/smoke`, WithDecryption: true }))).Parameter.Value);
  const idp = new CognitoIdentityProviderClient({ region, credentials });
  const COMMANDS = { InitiateAuth: InitiateAuthCommand, RespondToAuthChallenge: RespondToAuthChallengeCommand, AssociateSoftwareToken: AssociateSoftwareTokenCommand, VerifySoftwareToken: VerifySoftwareTokenCommand, SetUserMFAPreference: SetUserMFAPreferenceCommand };
  const name = `/dmt-${env}/manager/smoke-totp`;
  const ssm = {
    get: async () => {
      try {
        return (await ssmClient.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value;
      } catch (err) {
        if (err.name === 'ParameterNotFound') return 'none';
        throw err;
      }
    },
    put: (value) => ssmClient.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true })),
  };
  return { smoke, tokens: await signInSmoke({ smoke, cognito: (command, input) => idp.send(new COMMANDS[command](input)), ssm }) };
}
