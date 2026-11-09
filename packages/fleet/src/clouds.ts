// One model for both clouds (Google Cloud design §3): `account` is the AWS account or the Google Cloud project, so
// every key keeps its shape and the cloud is read from the account, never stored. The patterns of both clouds live here.
export type Cloud = 'aws' | 'gcp';

const ACCOUNT = /^\d{12}$/;
// A project ID: 6 to 30 characters, lowercase letters, digits and hyphens, starting with a letter, not ending with a hyphen.
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// Patterns rather than lists: a region launched later must not need an engine upgrade.
const REGIONS: Record<Cloud, RegExp> = {
  aws: /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  gcp: /^[a-z]+-[a-z]+\d{1,2}$/,
};

export const isAccount = (s: unknown): s is string => typeof s === 'string' && ACCOUNT.test(s);
export const isProject = (s: unknown): s is string => typeof s === 'string' && PROJECT.test(s);
export const cloudOf = (account: string): Cloud | null => (isAccount(account) ? 'aws' : isProject(account) ? 'gcp' : null);
export const isRegion = (cloud: Cloud, s: unknown): s is string => typeof s === 'string' && REGIONS[cloud].test(s);
// A candidate's region: a Google Cloud global load balancer's is `global`.
export const isCandidateRegion = (cloud: Cloud, s: unknown): s is string => isRegion(cloud, s) || (cloud === 'gcp' && s === 'global');

// The minutes of a five-field schedule that runs every N minutes (`*/N * * * *`, a Google Cloud router's Scheduler job).
export function fiveFieldMinutes(cron: string | null | undefined): number | null {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron ?? '');
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}
