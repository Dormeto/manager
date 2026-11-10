// The levels' settings as the manager checks them before a write (vision settings at scale design §4, §5): the router's
// words, the router keeping the last word.
import { describe, expect, it } from 'vitest';
import { defaultsProblems, typesProblems } from '../src/settings-levels.js';

const rule = (name: string) => ({ name, pathPrefixes: ['/health'] });

describe('a level\'s settings', () => {
  it('takes each setting in its range, a wake mode, rules, and null to unset', () => {
    expect(defaultsProblems({ idleMinutes: 30, wakeMode: 'browser', noWakeRules: [rule('a')], waitSeconds: null })).toEqual([]);
    expect(defaultsProblems({ idleMinutes: 4 })).toEqual(['idleMinutes: must be a whole number from 5 to 1440']);
    expect(defaultsProblems({ wakeTimeoutSeconds: 3601 })).toEqual(['wakeTimeoutSeconds: must be a whole number from 60 to 3600']);
    expect(defaultsProblems({ wakeMode: 'never' })).toEqual(['wakeMode: must be any or browser']);
    expect(defaultsProblems({ noWakeRules: Array.from({ length: 21 }, (_, i) => rule(`r${i}`)) })).toEqual(['noWakeRules: at most 20 rules']);
    expect(defaultsProblems({ wakeRules: [{ name: 'empty' }] })).toEqual(['wakeRules: rule empty: no condition']);
    expect(defaultsProblems({ wakeRules: [{ name: 'bad', pathPattern: '(' }] })[0]).toMatch(/^wakeRules: rule bad: pathPattern: /);
    expect(defaultsProblems({ noWakeRules: [{ name: 'ip', sourceIps: ['10.0.0.0/33'] }] })).toEqual(['noWakeRules: rule ip: sourceIps: invalid range 10.0.0.0/33']);
    expect(defaultsProblems({ wakeRules: [{ pathPrefixes: ['/x'] }] })).toEqual(['wakeRules: each rule needs a name (at most 64 characters)']);
    expect(defaultsProblems({ pollSeconds: 3 })).toEqual(['unknown setting pollSeconds']);
    expect(defaultsProblems({ type: 'api' })).toEqual(['unknown setting type']);
    expect(defaultsProblems({ type: 'api' }, { workload: true })).toEqual([]);
    expect(defaultsProblems({ type: 'Bad' }, { workload: true })).toEqual(['type: must be a type\'s name (lower-case letters, digits and hyphens) or null']);
    expect(defaultsProblems([])).toEqual(['settings must be an object']);
  });

  // A Google Cloud router's and workload's (router gcp/src/levels.mjs levelProblems): one controller request lasts at most
  // 1800 s; the hold, the drain and the holders are 0 there, which the router refuses in its own words.
  it('takes a Google Cloud wake timeout from 60 to 1700 s and leaves the hold, the drain and the holders to the router', () => {
    expect(defaultsProblems({ wakeTimeoutSeconds: 1700 }, { cloud: 'gcp' })).toEqual([]);
    expect(defaultsProblems({ wakeTimeoutSeconds: 1701 }, { cloud: 'gcp' })).toEqual(['wakeTimeoutSeconds: must be a whole number from 60 to 1700']);
    expect(defaultsProblems({ wakeTimeoutSeconds: 59 }, { cloud: 'gcp', workload: true })).toEqual(['wakeTimeoutSeconds: must be a whole number from 60 to 1700']);
    expect(defaultsProblems({ waitSeconds: 500, drainSeconds: 30, maxHolders: 0 }, { cloud: 'gcp' })).toEqual([]);
    expect(defaultsProblems({ idleMinutes: 4 }, { cloud: 'gcp' })).toEqual(['idleMinutes: must be a whole number from 5 to 1440']);
    // AWS's, and the levels both clouds share (the organization's, the types'), keep AWS's ranges.
    expect(defaultsProblems({ wakeTimeoutSeconds: 3600, waitSeconds: 500 })).toEqual(['waitSeconds: must be a whole number from 5 to 120']);
    expect(defaultsProblems({ wakeTimeoutSeconds: 1701 }, { cloud: 'aws' })).toEqual([]);
  });
});

describe('the organization\'s types', () => {
  const custom = (name: string, tags: Record<string, string> = { kind: name }) => ({ name, tags, settings: {} });
  it('takes custom types selected by tags and the built-in types\' defaults; refuses the rest in the router\'s words', () => {
    expect(typesProblems([custom('api'), { name: 'databases', settings: { idleMinutes: 30 } }])).toEqual([]);
    expect(typesProblems([{ name: 'ecs', tags: { kind: 'x' }, settings: {} }])).toEqual(['type ecs: a built-in type has no tags']);
    expect(typesProblems([custom('api'), custom('api')])).toEqual(['type api: named twice']);
    expect(typesProblems([custom('Bad_Name')])).toEqual(['type Bad_Name: a name is lower-case letters, digits and hyphens, starting with a letter (at most 32)']);
    expect(typesProblems([custom('api', {})])).toEqual(['type api: tags must select at least one tag (key and value)']);
    expect(typesProblems([{ name: 'api', tags: { kind: 'x' }, settings: { idleMinutes: 1 } }])).toEqual(['type api: settings: idleMinutes: must be a whole number from 5 to 1440']);
    expect(typesProblems(Array.from({ length: 21 }, (_, i) => custom(`t${i}`)))).toEqual(['at most 20 custom types']);
    expect(typesProblems({})).toEqual(['types must be a list']);
  });
});
