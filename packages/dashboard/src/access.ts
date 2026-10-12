// Organization access (packaging design §3): what an account misses, why, and the procedure that fixes it.
export type AccessState = { ok: true } | { ok: false; reason: string; discoveryOnly?: true };

export interface AccessRow {
  account: string;
  name: string;
  discovery: AccessState;
  command: AccessState;
  forwarder?: 'connected' | 'missing' | 'impossible';
  reason?: string;
}

export interface AccessReport {
  counts: { ready: number; discoveryMissing: number; commandMissing: number; discoveryOnly?: number; unchecked: number };
  accounts: AccessRow[];
  cursor: string | null;
  delegation: 'ok' | 'missing' | null;
  checkedAt: string | null;
  // Event-driven refresh on (packaging design §5).
  forwarders?: Forwarders;
  discoveryOnly?: string[];
}

export interface Forwarders {
  connected: number;
  connecting: number;
  impossible: { account: string; name: string; reason: string }[];
  failed?: { account: string; name: string; reason: string }[];
}

const accounts = (n: number) => `${n} account${n === 1 ? '' : 's'}`;
// Null: event-driven refresh is off.
export function forwardersLine(f: Forwarders | undefined): string | null {
  if (!f) return null;
  const parts = [`${accounts(f.connected)} connected`, ...(f.connecting ? [`${f.connecting} being connected`] : []), ...(f.impossible.length ? [`${f.impossible.length} not possible (refreshed daily)`] : []),
    ...(f.failed?.length ? [`${f.failed.length} failed (tried again within a day)`] : [])];
  return `Event-driven refresh: ${parts.join(', ')}.`;
}

// The website's page, with the roles' Terraform modules and AWS CLI commands.
export const PROCEDURE_URL = 'https://dormeto.com/organization-access.html';

// Why onboarding is refused in an account (the API refuses it too): said before trying. Null: let through.
export function onboardRefusal(report: AccessReport | null, account: string | undefined): string | null {
  if (!report || !account) return null;
  if (report.discoveryOnly?.includes(account)) return 'Its account is set up for discovery only (no command role): onboarding is not possible there.';
  const row = report.accounts.find((a) => a.account === account && !a.command.ok);
  return row && !row.command.ok ? `Its account has no command role: ${row.command.reason}. See Organization access.` : null;
}

export function countsLine(c: AccessReport['counts']): string {
  const parts = [`${c.ready} ready`, ...(c.discoveryMissing ? [`${c.discoveryMissing} without the discovery role`] : []), ...(c.commandMissing ? [`${c.commandMissing} without the command role`] : []),
    ...(c.discoveryOnly ? [`${c.discoveryOnly} for discovery only`] : []), ...(c.unchecked ? [`${c.unchecked} not checked yet`] : [])];
  return `${parts.join(', ')}.`;
}

export function accessLine(row: AccessRow): string {
  const missing = [!row.discovery.ok && 'no discovery role', !row.command.ok && 'no command role'].filter(Boolean).join(', ');
  const reason = (!row.discovery.ok && row.discovery.reason) || (!row.command.ok && row.command.reason) || '';
  const stops = [!row.discovery.ok && 'the account is not scanned', !row.command.ok && 'onboarding and router installs are refused'].filter(Boolean).join(', ');
  return `${missing} (${reason}): ${stops}`;
}

// The procedure: a static page (the website runs no script); the panel lists the accounts to set up.
export function procedureLink(): string {
  return PROCEDURE_URL;
}
