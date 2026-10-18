// The dashboard's themes (main.ts): every state color is Vuetify's or defined in both themes (user request: napping's own).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stateColor } from '../src/format';
import { THEMES, initialTheme } from '../src/theme';

const BUILT_IN = new Set(['success', 'info', 'warning', 'error', 'grey']);

describe('themes', () => {
  it('defines in both themes each state color Vuetify does not have', () => {
    const own = ['AWAKE', 'NAPPING', 'ASLEEP', 'WAKING', 'FAILED', 'UNKNOWN'].map(stateColor).filter((c) => !BUILT_IN.has(c));
    expect(own).toEqual(['napping']);
    for (const theme of ['light', 'dark'] as const) for (const color of own) expect(THEMES[theme].colors[color], `${theme} ${color}`).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the theme to start with', () => {
  const system = (dark: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && dark, media: query }));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem('dmt-theme');
  });

  it('follows the system\'s when the user chose none (PR #1)', () => {
    system(true);
    expect(initialTheme()).toBe('dark');
    system(false);
    expect(initialTheme()).toBe('light');
  });

  it('keeps the user\'s choice, whatever the system\'s', () => {
    system(true);
    window.localStorage.setItem('dmt-theme', 'light');
    expect(initialTheme()).toBe('light');
    system(false);
    window.localStorage.setItem('dmt-theme', 'dark');
    expect(initialTheme()).toBe('dark');
  });

  it('follows the system\'s when the storage cannot be read', () => {
    system(false);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(initialTheme()).toBe('light');
    getItem.mockRestore();
  });
});
