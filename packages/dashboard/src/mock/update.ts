// Demo data of the Update page: a manager installed with the CLI, running the demo's version with two newer ones (one
// whose Access line needs action), no build, no pending request and no plan. The requests answer the pending item
// the API would store; the demo does not run builds.
import type { Pending, Section, UpdateState } from '../update';
import { fail } from './state';

const RUNNING = '0.11.0';

export const updateState = (now: number): UpdateState => ({
  installedWithCli: true,
  version: RUNNING,
  applied: { version: RUNNING, build: 'dmt-demo-install:3f1c2a40-6b1d-4c1e-9a52-0d7e5f6a8b91', at: new Date(now - 9 * 86_400_000).toISOString() },
  cli: '0.12.0',
  versions: [
    { version: '0.13.0', router: '0.30.0', minCli: '0.2.0', published: new Date(now - 2 * 86_400_000).toISOString() },
    { version: '0.12.0', router: '0.29.0', minCli: '0.2.0', published: new Date(now - 6 * 86_400_000).toISOString() },
  ],
  build: null,
  pending: null,
  plan: null,
});

export const updateChanges = (to: string | null): Section[] => {
  const all: Section[] = [
    {
      version: '0.13.0',
      notes: '## 0.13.0 — demo\n\n### Added\n- The Update page: pick a newer version, read what it changes, prepare then confirm.\n- Router `0.30.0`, with **faster** wakes.\n\nSee [the procedure](https://dormeto.com/organization-access.html).',
      access: 'a new read permission is needed on the organization role',
      accessNeeded: true,
    },
    {
      version: '0.12.0',
      notes: '## 0.12.0 — demo\n\n### Fixed\n- The savings card counts a nap that spans midnight once.',
      access: 'nothing to apply again',
      accessNeeded: false,
    },
  ];
  const known = all.findIndex((s) => s.version === to);
  if (known < 0) fail(400, 'bad_request', `unknown version: ${to ?? ''}`);
  return all.slice(known);
};

export const updateRequest = (action: 'plan' | 'apply', version: string, now: number, planBuild?: string): Pending => ({
  key: `demo/requests/${action}`, id: `${action}-demo`, action, version, ...(planBuild ? { planBuild } : {}), at: new Date(now).toISOString(), who: 'demo@example.com',
});
