// The dashboard's themes (main.ts): every state color is Vuetify's or defined in both themes (user request: napping's own).
import { describe, expect, it } from 'vitest';
import { stateColor } from '../src/format';
import { THEMES } from '../src/theme';

const BUILT_IN = new Set(['success', 'info', 'warning', 'error', 'grey']);

describe('themes', () => {
  it('defines in both themes each state color Vuetify does not have', () => {
    const own = ['AWAKE', 'NAPPING', 'ASLEEP', 'WAKING', 'FAILED', 'UNKNOWN'].map(stateColor).filter((c) => !BUILT_IN.has(c));
    expect(own).toEqual(['napping']);
    for (const theme of ['light', 'dark'] as const) for (const color of own) expect(THEMES[theme].colors[color], `${theme} ${color}`).toMatch(/^#[0-9a-f]{6}$/);
  });
});
