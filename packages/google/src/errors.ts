// Google's refusals as one error: the HTTP status, Google's reason and Google's message, nothing else (never a token,
// a header or a request body).

export class GoogleError extends Error {
  // status: the HTTP status, 0 when Google never answered; reason: the google.rpc.ErrorInfo's (`IAM_PERMISSION_DENIED`),
  // an older API's (`forbidden`), Google's status (`NOT_FOUND`) or STS's error code (`unauthorized_client`).
  readonly status: number;
  readonly reason: string;

  constructor({ status, reason, message }: { status: number; reason: string; message: string }) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason;
  }
}

type GoogleBody = {
  error?: string | {
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
    details?: { '@type'?: string; reason?: string }[];
  };
  error_description?: string;
};

// A non-2xx answer's error: Google's JSON (an API's `{error: {...}}`, STS's `{error, error_description}`), or the start
// of an answer that isn't JSON (a load balancer's page).
export function errorOf(status: number, text: string): GoogleError {
  let body: GoogleBody | undefined;
  try {
    body = JSON.parse(text) as GoogleBody;
  } catch { /* not JSON */ }
  const e = body?.error;
  if (typeof e === 'string') return new GoogleError({ status, reason: e, message: body?.error_description ?? e });
  if (e && typeof e === 'object') {
    const info = e.details?.find((d) => d['@type']?.endsWith('google.rpc.ErrorInfo'));
    return new GoogleError({ status, reason: info?.reason ?? e.errors?.[0]?.reason ?? e.status ?? '', message: e.message ?? '' });
  }
  return new GoogleError({ status, reason: '', message: text.trim().slice(0, 300) || `HTTP ${status}` });
}
