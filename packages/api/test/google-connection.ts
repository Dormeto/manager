// The Google Cloud connection as `dormeto gcp connect` writes it (PUT /iam/discovery/google) and as GET
// /api/discovery/google answers it, `{ connection }` (null when there is none): the API's test checks its answers against
// these, and the dashboard's test reads these same answers, so the two never drift apart. Plain data: the dashboard's test
// imports it too.
export const GOOGLE_RECORD = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-dev', 'folders/42'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
  // A router connect read (its controller and version), and one it left for discovery to learn.
  routers: [
    { project: 'dormeto-dev', region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app', version: '0.40.0' },
    { project: 'dormeto-dev', region: 'us-central1' },
  ],
  googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'arn:aws:iam::121014831971:user/fab', cli: '0.14.0',
};
export const GOOGLE_ANSWER = { connection: GOOGLE_RECORD };
export const NO_GOOGLE_ANSWER = { connection: null };
