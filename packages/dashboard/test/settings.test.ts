import { describe, expect, it } from 'vitest';
import { formOf, settingRows, settingsChanges, sourceText, typeText } from '../src/settings';

describe('settingRows', () => {
  it('formats every workload setting with an explanation and its acceptable range', () => {
    const rows = settingRows({ waitSeconds: 60, idleMinutes: 15, drainSeconds: 30, wakeTimeoutSeconds: 1800, maxHolders: 50 });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Idle window', '15 min'],
      ['Hold', '60 s'],
      ['Drain', '30 s'],
      ['Wake timeout', '30 min'],
      ['Held requests', '≤ 50'],
    ]);
    for (const row of rows) {
      expect(row.help.length).toBeGreaterThan(80);
      expect(row.range).toMatch(/\S/);
    }
    expect(rows[1]!.range).toMatch(/load balancer idle timeout/);
  });

  // Settings at scale (vision design §9): where each comes from; the retry when the router gives it (0.37.0).
  it('says where each setting comes from, and shows the retry after a failed wake when the router gives it', () => {
    const rows = settingRows({ waitSeconds: 20, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60 },
      { idleMinutes: 'workload', waitSeconds: 'type', drainSeconds: 'router', wakeTimeoutSeconds: 'default', maxHolders: 'organization', failedRetrySeconds: 'default', wakeMode: 'default' });
    expect(rows.map((r) => [r.label, r.value, r.from])).toEqual([
      ['Idle window', '30 min', 'workload'], ['Hold', '20 s', 'type'], ['Drain', '30 s', 'router'], ['Wake timeout', '10 min', 'default'],
      ['Held requests', '≤ 50', 'organization'], ['Retry after a failed wake', '60 s', 'default'],
    ]);
  });
});

describe('sources and types', () => {
  it('says each level in a few words', () => {
    expect(['workload', 'type', 'router', 'organization', 'default', undefined].map((from) => sourceText(from, { name: 'api', from: 'tags' })))
      .toEqual(['set on this workload', 'type api', 'router', 'organization', 'built-in', '']);
  });

  it('says a workload\'s type and where it comes from, and a type removed since', () => {
    expect(typeText({ name: 'api', from: 'tags' })).toBe('api, from its tags');
    expect(typeText({ name: 'ecs', from: 'backends' })).toBe('ecs, from its backends');
    expect(typeText({ name: 'web', from: 'workload' })).toBe('web, set on this workload');
    expect(typeText({ name: 'ecs', from: 'backends', missing: 'gone' })).toBe('ecs, from its backends (its type gone no longer exists)');
    expect(typeText({ name: null, from: null })).toBe('none');
  });
});

describe('the settings dialog\'s form', () => {
  const status = {
    settings: { waitSeconds: 20, idleMinutes: 45, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60 }, wakeMode: 'browser',
    settingsFrom: { idleMinutes: 'workload', waitSeconds: 'type', drainSeconds: 'default', wakeTimeoutSeconds: 'default', maxHolders: 'default', failedRetrySeconds: 'default', wakeMode: 'workload' },
    type: { name: 'api', from: 'tags' },
    noWakeRules: [{ name: 'health', level: 'organization', conditions: { pathPrefixes: ['/health'] } }, { name: 'own', level: 'workload', conditions: { pathPrefixes: ['/x'] } }],
    wakeRules: [{ name: 'key', level: 'wake', from: 'type', conditions: { headers: [{ name: 'x-api-key', pattern: '.+' }] } }],
  };

  it('starts from the workload\'s own values: the others inherit', () => {
    expect(formOf(status as never)).toEqual({
      idleMinutes: 45, waitSeconds: null, drainSeconds: null, wakeTimeoutSeconds: null, maxHolders: null, failedRetrySeconds: null, wakeMode: 'browser', type: null,
      noWakeRules: JSON.stringify([{ name: 'own', pathPrefixes: ['/x'] }], null, 2), wakeRules: '[]',
    });
  });

  it('sends only what changed: a value, null for an own value emptied, the rules parsed', () => {
    const initial = formOf(status as never);
    expect(settingsChanges(initial, { ...initial, idleMinutes: null, waitSeconds: '25' as never, type: 'web', wakeRules: '[{"name":"k","pathPrefixes":["/api/"]}]' }))
      .toEqual({ changes: { idleMinutes: null, waitSeconds: 25, type: 'web', wakeRules: [{ name: 'k', pathPrefixes: ['/api/'] }] }, problem: null });
    expect(settingsChanges(initial, { ...initial, noWakeRules: '' })).toEqual({ changes: { noWakeRules: null }, problem: null });
    expect(settingsChanges(initial, initial)).toEqual({ changes: {}, problem: null });
    expect(settingsChanges(initial, { ...initial, wakeRules: '{' }).problem).toMatch(/^Wake rules: /);
    expect(settingsChanges(initial, { ...initial, wakeRules: '{}' }).problem).toBe('Wake rules: a JSON list of rules');
  });
});
