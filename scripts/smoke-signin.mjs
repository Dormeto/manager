// The smoke user's sign-in (R6c): its password, then a code of its authenticator app when the user pool asks for one.
// Under the operators or required MFA policy the smoke user (an administrator) needs one: enrolled once, its secret kept
// in SSM (/dmt-<env>/manager/smoke-totp).
import { totp } from './totp.mjs';

const STEP_MS = 30_000;

// cognito(name, input): a Cognito user pools call; ssm: { get(), put(value) } of the secret's parameter ('none' until
// enrolled); enroll: false leaves a user without an authenticator as it is (policy optional).
export async function signInSmoke({ smoke, cognito, ssm, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, enroll = true }) {
  const nextStep = () => sleep(STEP_MS - (now() % STEP_MS) + 1000);
  // A code is accepted once: a sign-in a moment ago (another script, a rerun) used this step's, so the next one is waited.
  const signIn = async (retry = true) => {
    try {
      return await attempt();
    } catch (err) {
      if (!retry || err.name !== 'ExpiredCodeException') throw err;
      await nextStep();
      return signIn(false);
    }
  };
  const attempt = async () => {
    const out = await cognito('InitiateAuth', { ClientId: smoke.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: smoke.username, PASSWORD: smoke.password } });
    if (out.AuthenticationResult) return out;
    if (out.ChallengeName !== 'SOFTWARE_TOKEN_MFA') throw new Error(`smoke sign-in: unexpected challenge ${out.ChallengeName}`);
    const secret = await ssm.get();
    if (!secret || secret === 'none') throw new Error('smoke sign-in: an authenticator is set up but its secret is not in SSM (reset the smoke user\'s MFA)');
    return cognito('RespondToAuthChallenge', {
      ClientId: smoke.clientId, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: out.Session,
      ChallengeResponses: { USERNAME: smoke.username, SOFTWARE_TOKEN_MFA_CODE: totp(secret, now()) },
    });
  };
  const first = await signIn();
  const secret = await ssm.get();
  if (!enroll || (secret && secret !== 'none')) return first.AuthenticationResult;
  // Enrolled with this session's access token, then signed in again with a code of the next step (a code is used once).
  const AccessToken = first.AuthenticationResult.AccessToken;
  const { SecretCode } = await cognito('AssociateSoftwareToken', { AccessToken });
  const verified = await cognito('VerifySoftwareToken', { AccessToken, UserCode: totp(SecretCode, now()), FriendlyDeviceName: 'smoke' });
  if (verified.Status !== 'SUCCESS') throw new Error('smoke sign-in: the authenticator code was refused');
  await cognito('SetUserMFAPreference', { AccessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } });
  await ssm.put(SecretCode);
  await nextStep();
  return (await signIn()).AuthenticationResult;
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
