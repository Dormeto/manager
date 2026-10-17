import { idToken, signIn } from './auth';
import { DEMO, demo } from './mock/enabled';

export class ApiError extends Error {
  // body: the error answer of the API, for example the validation errors of a configuration.
  constructor(readonly status: number, message: string, readonly body: unknown = null) {
    super(message);
  }
}

// JSON call to the manager API with the ID token; an expired session goes back to the sign-in.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Demo data (npm run dev:mock, development only): answered in the browser, errors as ApiError.
  if (DEMO) return (await (await demo()).mockApi(path, init)) as T;
  const token = await idToken();
  if (!token) {
    await signIn(window.location.pathname + window.location.search);
    throw new ApiError(401, 'sign in required');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    await signIn(window.location.pathname + window.location.search);
    throw new ApiError(401, 'sign in required');
  }
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText, body);
  return body as T;
}
