// The demo organization of this page load (npm run dev:mock), generated from a scenario (scenario.ts): the address's
// ?demo=<scenario> (kept for the tab; ?demo= alone goes back to the default), else VITE_MOCK_SCENARIO, else the default.
import { organization, parseScenario } from './scenario';

const KEY = 'dormeto.demo';

function scenarioText(): string | undefined {
  const fallback = import.meta.env.VITE_MOCK_SCENARIO;
  try {
    const asked = new URLSearchParams(window.location.search).get('demo');
    if (asked === null) return sessionStorage.getItem(KEY) ?? fallback;
    if (asked) sessionStorage.setItem(KEY, asked);
    else sessionStorage.removeItem(KEY);
    return asked || fallback;
  } catch {
    return fallback;
  }
}

export const ORG = organization(parseScenario(scenarioText()));
export const ME = ORG.me;
export const ACCOUNTS = ORG.accounts;
export const accountName = (id: string): string => ACCOUNTS.find((a) => a.id === id)?.name ?? id;
