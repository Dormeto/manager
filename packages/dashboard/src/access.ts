// Organization access (packaging design §3): what an account misses, why, and the procedure that fixes it.
export type AccessState = { ok: true } | { ok: false; reason: string };

export interface AccessRow {
  account: string;
  name: string;
  discovery: AccessState;
  command: AccessState;
  forwarder?: 'connected' | 'missing' | 'impossible';
  reason?: string;
}

export interface AccessReport {
  counts: { ready: number; discoveryMissing: number; commandMissing: number; unchecked: number };
  accounts: AccessRow[];
  cursor: string | null;
  delegation: 'ok' | 'missing' | null;
  checkedAt: string | null;
}

// The website's page, with the roles' Terraform modules and AWS CLI commands.
export const PROCEDURE_URL = 'https://dormeto.com/organization-access.html';
const LINKED_ACCOUNTS = 40;

export function accessLine(row: AccessRow): string {
  const missing = [!row.discovery.ok && 'no discovery role', !row.command.ok && 'no command role'].filter(Boolean).join(', ');
  const reason = (!row.discovery.ok && row.discovery.reason) || (!row.command.ok && row.command.reason) || '';
  const stops = [!row.discovery.ok && 'the account is not scanned', !row.command.ok && 'onboarding and router installs are refused'].filter(Boolean).join(', ');
  return `${missing} (${reason}): ${stops}`;
}

// The procedure, with the accounts to set up (in the fragment: never sent to a server).
export function procedureLink(accounts: string[]): string {
  return accounts.length ? `${PROCEDURE_URL}#accounts=${accounts.slice(0, LINKED_ACCOUNTS).join(',')}` : PROCEDURE_URL;
}
