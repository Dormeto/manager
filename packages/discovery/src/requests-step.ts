// The requests step of the discovery function (the idle window advisor's R10), apart from the handler so that it is
// tested without the handler's AWS clients: AWS's form (a target group) reads CloudWatch under the discovery role; the
// Google Cloud form (a backend service, recognized by its own field) reads Cloud Monitoring as the discovery account.
import type { Google, GoogleConnection } from '@dormeto/google';
import { googleRequestsStep } from './gcp-requests.js';
import { requestMinutes, type RequestsPorts } from './requests.js';

export interface RequestsStepDeps {
  // The Google source: the record is read at each step (a fresh execution environment keeps nothing until it is read).
  google: { current(): Promise<{ connection: GoogleConnection; google: Pick<Google, 'call'> } | null> };
  // AWS's ports for an account and a region (the handler assumes the discovery role there).
  aws(account: string, region: string): Promise<RequestsPorts>;
}

export async function requestsStep(deps: RequestsStepDeps, event: Record<string, unknown>, now: number) {
  if (event.backendService !== undefined) {
    // Read before Monitoring is asked: no connection is not a Monitoring refusal.
    const current = await deps.google.current();
    if (!current) throw new Error('no Google Cloud connection: dormeto gcp connect makes one');
    return googleRequestsStep({ call: (method, url, body) => current.google.call('discovery', method, url, body) }, event, now);
  }
  const { account, region, targetGroupArn, days } = event;
  if (typeof account !== 'string' || typeof region !== 'string' || typeof targetGroupArn !== 'string' || typeof days !== 'number') {
    throw new Error('the requests of a workload need an account, a region, a target group ARN and days');
  }
  return requestMinutes(await deps.aws(account, region), { targetGroupArn, days, now });
}
