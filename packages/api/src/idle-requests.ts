// The idle window advisor's requests (R10): the discovery function's step requests, invoked by the API, since member
// accounts trust only the discovery role to read them. Its reserved executions may all be taken by a discovery run.
import type { ActivityQuery, RequestMinutes } from '@dormeto/fleet';

// What a workload's requests are read from: AWS's application target group, or a Google Cloud workload's backend services
// (the application's and its waker's), URL map and load balancer, as paths (§9.4).
export type IdleTarget = { targetGroupArn: string } | { backendService: string; wakerBackendService: string; urlMap: string; lb: { kind: string; region?: string } };
// `wakerTargetGroupArn` is AWS's waker; `wakerBackendService` is Google Cloud's (the other is null or absent).
export type IdleRequests = (account: string, region: string, target: IdleTarget, days: number) => Promise<RequestMinutes & { wakerTargetGroupArn: string | null; wakerBackendService?: string }>;
// A standalone workload's signals over its last days (vision standalone workloads design §6): the discovery function's step
// activity, each query's 5-minute points as minutes from `from`.
export type IdleActivity = (account: string, region: string, queries: ActivityQuery[], days: number) => Promise<{ from: string; to: string; points: Record<string, [number, number][]> }>;
export const BUSY = 'discovery is busy (a discovery run uses its capacity): try again in a few minutes';

// The activity step, invoked as the requests step is.
export function createIdleActivity({ invoke, functionName }: Parameters<typeof createIdleRequests>[0]): IdleActivity {
  return async (account, region, queries, days) => {
    let out: { Payload?: Uint8Array; FunctionError?: string };
    try {
      out = await invoke({ FunctionName: functionName, Payload: new Uint8Array(Buffer.from(JSON.stringify({ step: 'activity', account, region, queries, days }))) });
    } catch (err) {
      if ((err as Error).name === 'TooManyRequestsException') throw new Error(BUSY);
      throw err;
    }
    const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : 'null';
    if (out.FunctionError) throw new Error((JSON.parse(text) as { errorMessage?: string }).errorMessage ?? out.FunctionError);
    return JSON.parse(text) as Awaited<ReturnType<IdleActivity>>;
  };
}

export function createIdleRequests({ invoke, functionName }: {
  invoke(input: { FunctionName: string; Payload: Uint8Array }): Promise<{ Payload?: Uint8Array; FunctionError?: string }>;
  functionName: string;
}): IdleRequests {
  return async (account, region, target, days) => {
    let out: { Payload?: Uint8Array; FunctionError?: string };
    try {
      out = await invoke({ FunctionName: functionName, Payload: new Uint8Array(Buffer.from(JSON.stringify({ step: 'requests', account, region, ...target, days }))) });
    } catch (err) {
      if ((err as Error).name === 'TooManyRequestsException') throw new Error(BUSY);
      throw err;
    }
    const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : 'null';
    if (out.FunctionError) throw new Error((JSON.parse(text) as { errorMessage?: string }).errorMessage ?? out.FunctionError);
    return JSON.parse(text) as Awaited<ReturnType<IdleRequests>>;
  };
}
