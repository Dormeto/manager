// The manager's self-update. Pure part: version order, the versions offered, the plan summary, a changelog section's
// Access line and request ids (no I/O).

export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

// The CLI's CompareVersions: the three numbers, then a pre-release before its release, two pre-releases as text.
export function compareVersions(a: string, b: string): number {
  for (const v of [a, b]) if (!VERSION.test(v)) throw new Error(`not a version: ${v}`);
  const [na, pa] = split(a);
  const [nb, pb] = split(b);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i]! < nb[i]! ? -1 : 1;
  if (pa === pb) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa < pb ? -1 : 1;
}

function split(v: string): [number[], string | null] {
  const i = v.indexOf('-');
  const core = i < 0 ? v : v.slice(0, i);
  return [core.split('.').map(Number), i < 0 ? null : v.slice(i + 1)];
}

// The CLI's AtLeast: the three numbers only (`0.2.0-dev` meets `0.2.0`); a version not starting with x.y.z does not.
export function atLeastCore(version: string, floor: string): boolean {
  const v = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(version);
  const f = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(floor);
  if (!v || !f) return false;
  for (let i = 1; i <= 3; i++) if (v[i] !== f[i]) return Number(v[i]) > Number(f[i]);
  return true;
}

export type VersionEntry = { version: string; router: string | null; minCli: string | null; published: string | null; staged?: boolean };

const DEFAULT_MIN_CLI = '0.2.0';

// Why a version cannot be applied from the dashboard: the install's CLI is unknown or older than the entry's floor.
export function cliReason(minCli: string | null): string {
  return `run \`dormeto install\` with the CLI ${minCli ?? DEFAULT_MIN_CLI} or later`;
}

// The entries newer than `running`, newest first; the staged one joins unless a published entry has its version.
export function offered(versions: VersionEntry[], running: string, cli: string | null, staged: VersionEntry | null): Array<VersionEntry & { disabled?: string }> {
  const entries = versions.filter((e) => VERSION.test(e.version));
  if (staged && VERSION.test(staged.version) && !entries.some((e) => e.version === staged.version)) entries.push(staged);
  return entries
    .filter((e) => compareVersions(e.version, running) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((e) => (cli === null || (e.minCli !== null && !atLeastCore(cli, e.minCli)) ? { ...e, disabled: cliReason(e.minCli) } : { ...e }));
}

export type PlanSummary = { add: number; change: number; destroy: number; replaced: string[]; destroyed: string[] };

// The CLI's Summarize over `terraform show -json`: a delete with a create counts once as added and once as destroyed.
export function summarizePlan(planJson: string): PlanSummary {
  const plan = JSON.parse(planJson) as { format_version?: unknown; resource_changes?: Array<{ address: string; change: { actions: string[] } }> } | null;
  if (!plan || typeof plan !== 'object' || (plan.format_version === undefined && plan.resource_changes === undefined)) throw new Error('not a Terraform plan');
  const s: PlanSummary = { add: 0, change: 0, destroy: 0, replaced: [], destroyed: [] };
  for (const rc of plan.resource_changes ?? []) {
    switch (rc.change.actions.join(',')) {
      case 'create': s.add++; break;
      case 'update': s.change++; break;
      case 'delete': s.destroy++; s.destroyed.push(rc.address); break;
      case 'delete,create':
      case 'create,delete': s.add++; s.destroy++; s.replaced.push(rc.address); break;
    }
  }
  s.replaced.sort();
  s.destroyed.sort();
  return s;
}

export type Section = { version: string; notes: string | null; access: string | null; accessNeeded: boolean };

// The "Access: …" sentence of a section's "Router … Access: …" paragraph, unwrapped; needed unless nothing is to be applied again.
export function accessOf(section: string): { access: string | null; accessNeeded: boolean } {
  for (const paragraph of section.split(/\n\s*\n/)) {
    const text = paragraph.trim().split('\n').map((l) => l.trim()).join(' ');
    if (!text.startsWith('Router ')) continue;
    const at = text.indexOf('Access: ');
    if (at < 0) continue;
    const access = text.slice(at);
    return { access, accessNeeded: !access.slice('Access: '.length).startsWith('nothing to apply again') };
  }
  return { access: null, accessNeeded: false };
}

// `YYYYMMDDTHHMMSSZ-<8 hex>`, in UTC.
export function requestId(now: Date, random: string): string {
  if (!/^[0-9a-f]{8}$/.test(random)) throw new Error(`not 8 lowercase hex characters: ${random}`);
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z-${random}`;
}
