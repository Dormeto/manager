// Calls of the signed-in user to the Cognito user pools API (MFA set-up, R6c), authorized with their access token: no
// SDK, the JSON protocol over fetch (the CSP allows cognito-idp in the user pool's region).
import { getConfig } from './config';
import { DEMO, demo } from './mock/enabled';

export async function cognito<T = Record<string, unknown>>(target: string, body: Record<string, unknown>): Promise<T> {
  // Demo data (npm run dev:mock, development only): the set-up succeeds in the browser.
  if (DEMO) return (await (await demo()).mockCognito(target, body)) as T;
  // authority: https://cognito-idp.<region>.amazonaws.com/<user pool id>
  const endpoint = new URL(getConfig().authority).origin;
  const res = await fetch(`${endpoint}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as T & { message?: string; __type?: string };
  if (!res.ok) throw new Error(out.message ?? out.__type ?? `HTTP ${res.status}`);
  return out;
}
