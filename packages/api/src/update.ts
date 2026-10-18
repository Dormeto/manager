// The manager's self-update. The pure part comes first: version order, the versions offered, the plan summary, a
// changelog section's Access line and request ids (no I/O). The service follows, over a port.
import { HttpError } from './api.js';

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

// ---- The service ----

export type Build = { id: string; status: string; phase: string | null; startedAt: string | null; endedAt: string | null; env: Record<string, string>; logStream: string | null };
export type Pending = { key: string; id: string; etag: string; action: 'plan' | 'apply'; version: string; planBuild?: string; at: string; who: string };

export type UpdatePort = {
  // The install bucket, by key (`<env>/…`): null when the object is absent, an error for any other failure.
  get(key: string): Promise<string | null>;
  // Returns the object's ETag, without its quotes.
  put(key: string, body: string): Promise<string>;
  // The install project's newest builds, newest first.
  builds(): Promise<Build[]>;
  logLines(group: string, stream: string): Promise<string[]>;
  // null on any failure.
  fetchText(url: string): Promise<string | null>;
  pending: { get(): Promise<Pending | null>; put(p: Pending | null): Promise<void> };
};

export type BuildView = {
  id: string; by: 'dashboard' | 'cli'; action: string | null; version: string | null; status: string; phase: string | null;
  startedAt: string | null; endedAt: string | null; steps: string[]; tail: string[];
};

export type UpdateState = {
  installedWithCli: true;
  version: string;
  applied: { version: string; build: string; at: string | null } | null;
  cli: string | null;
  versions: Array<VersionEntry & { disabled?: string }>;
  build: BuildView | null;
  pending: (Pending & { notStarted?: true }) | null;
  plan: { build: string; version: string; summary: PlanSummary } | null;
};

export type UpdateService = {
  state(): Promise<UpdateState>;
  changes(to: string): Promise<Section[]>;
  plan(version: string, who: string): Promise<Pending>;
  apply(planBuild: string, who: string): Promise<Pending>;
};

type Result = { build: string; status: string; message: string; action: string; version: string };

const NOT_STARTED_MS = 120_000;
const TAIL = 40;
const BUILDS = 20;
const LOG_PAGES = 10;
const FAILED = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED']);
const PLAN_BUILD = /^dmt-[a-z0-9-]+-install:[0-9a-f-]{36}$/;
const isPlan = (action: string | null) => action === 'plan' || action === 'plan-destroy';
const isApply = (action: string | null) => action === 'apply' || action === 'apply-destroy';

function parse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

// S3 answers AccessDenied (403), not NoSuchKey, for a missing key when the caller may not list the bucket, as the API may
// not: the module grants exactly the keys the service reads, so a 403 on them means absent.
export function absent(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return ['NoSuchKey', 'NotFound', 'AccessDenied'].includes(e.name ?? '') || e.$metadata?.httpStatusCode === 404 || e.$metadata?.httpStatusCode === 403;
}

// A build's log stream may not exist yet when its name is already known.
export const missingStream = (err: unknown) => (err as { name?: string }).name === 'ResourceNotFoundException';

const textOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

// A version's own section of a CHANGELOG.md: from its `## <version>` heading to the next `## `.
function sectionOf(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trimEnd();
}

export function createUpdate(port: UpdatePort, o: { env: string; logGroup: string; version: string; releasesUrl: string; now: () => Date; random: () => string }): UpdateService {
  const key = (path: string) => `${o.env}/${path}`;

  async function published(): Promise<VersionEntry[]> {
    const list = parse<{ versions?: unknown }>(await port.fetchText(`${o.releasesUrl}/versions.json`));
    if (list && Array.isArray(list.versions)) {
      return list.versions
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { version?: unknown }).version === 'string')
        .map((e) => ({ version: e.version as string, router: textOrNull(e.router), minCli: textOrNull(e.minCli), published: textOrNull(e.published) }));
    }
    const latest = parse<Record<string, unknown>>(await port.fetchText(`${o.releasesUrl}/latest.json`));
    return typeof latest?.version === 'string' ? [{ version: latest.version, router: textOrNull(latest.router), minCli: null, published: textOrNull(latest.published) }] : [];
  }

  // The release the CLI staged in the install bucket: the version of its terraform-aws-dormeto-<v>.zip checksum line.
  async function staged(): Promise<VersionEntry | null> {
    const sums = await port.get(key('release/SHA256SUMS'));
    const version = /^\S+\s+\*?terraform-aws-dormeto-(\S+)\.zip$/m.exec(sums ?? '')?.[1];
    return version && VERSION.test(version) ? { version, router: null, minCli: null, published: null, staged: true } : null;
  }

  async function offers() {
    const cli = parse<{ version?: unknown }>(await port.get(key('cli.json')))?.version;
    const cliVersion = typeof cli === 'string' ? cli : null;
    return { cli: cliVersion, versions: offered(await published(), o.version, cliVersion, await staged()) };
  }

  const resultOf = async (id: string) => parse<Result>(await port.get(key(`results/${id}.json`)));

  // What a build is: a request build's action and version come from its result (`results/<build id>.json`); a CLI build's
  // from its environment.
  async function describe(b: Build): Promise<{ by: 'dashboard' | 'cli'; action: string | null; version: string | null }> {
    if (b.env.ACTION !== 'request') return { by: 'cli', action: b.env.ACTION || null, version: b.env.RELEASE_VERSION || null };
    const result = await resultOf(b.id);
    return { by: 'dashboard', action: result?.action || null, version: result?.version || null };
  }

  // A request is done with a final result, or a running one whose build ended without writing its final result (timed
  // out, stopped, faulted). It is not started after 2 minutes without a result, unless a build took it (it may still queue).
  async function pendingNow(pending: Pending | null, builds: Build[]): Promise<UpdateState['pending']> {
    if (!pending) return null;
    const result = await resultOf(pending.id);
    // Its build: the one its result names, else a listed request build carrying its request's ETag.
    const mine = builds.find((b) => (result?.build ? b.id === result.build : b.env.ACTION === 'request' && b.env.REQUEST_ETAG === pending.etag));
    const ended = !!mine && mine.status !== 'IN_PROGRESS';
    if (result?.status === 'succeeded' || result?.status === 'failed' || ended) {
      await port.pending.put(null);
      return null;
    }
    if (!result && !mine && o.now().getTime() - Date.parse(pending.at) > NOT_STARTED_MS) return { ...pending, notStarted: true };
    return pending;
  }

  // The newest plan build is the confirmable plan when a dashboard plan succeeded, with its release.json, and no plan
  // build started nor apply succeeded after it.
  async function confirmable(builds: Build[]): Promise<UpdateState['plan']> {
    for (const b of builds) {
      const { by, action } = await describe(b);
      if (isApply(action) && b.status === 'SUCCEEDED') return null;
      if (!isPlan(action)) continue;
      if (by !== 'dashboard' || action !== 'plan') return null;
      if ((await resultOf(b.id))?.status !== 'succeeded') return null;
      const release = parse<{ version?: unknown }>(await port.get(key(`plans/${b.id}/release.json`)));
      const planJson = await port.get(key(`plans/${b.id}/plan.json`));
      if (typeof release?.version !== 'string' || planJson === null) return null;
      return { build: b.id, version: release.version, summary: summarizePlan(planJson) };
    }
    return null;
  }

  async function view(b: Build): Promise<BuildView> {
    const lines = b.logStream ? await port.logLines(o.logGroup, b.logStream) : [];
    return {
      id: b.id, ...(await describe(b)), status: b.status, phase: b.phase, startedAt: b.startedAt, endedAt: b.endedAt,
      steps: lines.filter((l) => l.startsWith('dormeto: ')).map((l) => l.slice('dormeto: '.length)),
      tail: FAILED.has(b.status) ? lines.slice(-TAIL) : [],
    };
  }

  async function state(): Promise<UpdateState> {
    const [builds, storedPending, { cli, versions }] = await Promise.all([port.builds(), port.pending.get(), offers()]);
    const applied = parse<{ version?: unknown; build?: unknown }>(await port.get(key('applied.json')));
    return {
      installedWithCli: true,
      version: o.version,
      applied: typeof applied?.version === 'string' && typeof applied.build === 'string'
        ? { version: applied.version, build: applied.build, at: builds.find((b) => b.id === applied.build)?.endedAt ?? null }
        : null,
      cli,
      versions,
      build: builds[0] ? await view(builds[0]) : null,
      pending: await pendingNow(storedPending, builds),
      plan: await confirmable(builds),
    };
  }

  function busy(s: UpdateState) {
    if (s.build?.status === 'IN_PROGRESS') throw new HttpError(409, 'busy', 'an install build is running');
    if (s.pending && !s.pending.notStarted) throw new HttpError(409, 'busy', 'a request is waiting for its build');
  }

  async function request(body: { action: 'plan' | 'apply'; version: string; planBuild?: string }, who: string): Promise<Pending> {
    const id = requestId(o.now(), o.random());
    const at = o.now().toISOString();
    const requestKey = key(`requests/${id}.json`);
    const etag = await port.put(requestKey, JSON.stringify({ ...body, requestedBy: who, requestedAt: at }));
    const pending: Pending = { key: requestKey, id, etag, ...body, at, who };
    await port.pending.put(pending);
    return pending;
  }

  return {
    state,

    async changes(to) {
      const { versions } = await offers();
      if (!versions.some((v) => v.version === to)) throw new HttpError(400, 'bad_request', `${to} is not a version to update to`);
      return Promise.all(versions.filter((v) => compareVersions(v.version, to) <= 0).map(async (v): Promise<Section> => {
        const changelog = v.staged ? await port.get(key('release/CHANGELOG.md')).catch(() => null) : await port.fetchText(`${o.releasesUrl}/${v.version}/CHANGELOG.md`);
        const notes = changelog === null ? null : sectionOf(changelog, v.version);
        return { version: v.version, notes, ...(notes === null ? { access: null, accessNeeded: false } : accessOf(notes)) };
      }));
    },

    async plan(version, who) {
      if (!VERSION.test(version)) throw new HttpError(400, 'bad_request', 'version must look like 1.2.3');
      const s = await state();
      busy(s);
      const entry = s.versions.find((v) => v.version === version);
      if (!entry) throw new HttpError(400, 'bad_request', `${version} is not a version to update to`);
      if (entry.disabled) throw new HttpError(400, 'bad_request', entry.disabled);
      return request({ action: 'plan', version }, who);
    },

    async apply(planBuild, who) {
      if (!PLAN_BUILD.test(planBuild)) throw new HttpError(400, 'bad_request', 'planBuild is not a plan build');
      const s = await state();
      busy(s);
      if (!s.plan || s.plan.build !== planBuild) throw new HttpError(400, 'bad_request', 'that plan is not the latest one, or is no longer current');
      return request({ action: 'apply', version: s.plan.version, planBuild }, who);
    },
  };
}
