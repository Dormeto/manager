// The manager's self-update, as the API answers it (packages/api/src/update.ts: the dashboard does not import from the
// API package, so the shapes are mirrored here).

export type VersionEntry = { version: string; router: string | null; minCli: string | null; published: string | null; staged?: boolean };
export type PlanSummary = { add: number; change: number; destroy: number; replaced: string[]; destroyed: string[] };
export type Section = { version: string; notes: string | null; access: string | null; accessNeeded: boolean };
// operation: the request's manager update operation.
export type Pending = { key: string; id: string; action: 'plan' | 'apply'; version: string; planBuild?: string; at: string; who: string; operation?: string };
// consoleUrl: the build's page in the CodeBuild console.
export type BuildView = {
  id: string; by: 'dashboard' | 'cli'; action: string | null; version: string | null; status: string; phase: string | null;
  startedAt: string | null; endedAt: string | null; steps: string[]; tail: string[]; consoleUrl: string | null;
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
  releasesUnreachable?: true;
};
export type NotInstalled = { installedWithCli: false; version: string };

export const FAST_MS = 5_000;
export const SLOW_MS = 60_000;
// Failed polls are retried silently this long (the API is replaced during its own apply).
export const SILENT_MS = 120_000;

// A build runs, or a request waits for its build: the page follows closely and offers no new request.
export const busy = (s: UpdateState) => s.build?.status === 'IN_PROGRESS' || (s.pending !== null && !s.pending.notStarted);

export const pollDelay = (s: UpdateState | NotInstalled | null) => (s && s.installedWithCli && busy(s) ? FAST_MS : SLOW_MS);

// A text cut at its `code` spans, to show them as code and everything else as text (never as HTML).
export function codeParts(text: string): Array<{ code: boolean; text: string }> {
  return text.split('`').map((part, i) => ({ code: i % 2 === 1, text: part })).filter((p) => p.text);
}

// The notes of a section start with their own "## <version> — <date>" line, which the page shows as its heading.
export function withoutOwnHeading(notes: string, version: string): string {
  const lines = notes.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^##\s/.test(lines[first]!) && lines[first]!.includes(version)) lines.splice(0, first + 1);
  return lines.join('\n').trim();
}

// A link to the CodeBuild console as the API gives it, only when it is an https: one.
export const consoleLink = (url: unknown): string | null => (typeof url === 'string' && url.startsWith('https://') ? url : null);
