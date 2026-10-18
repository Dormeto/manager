// Tags and grants (tags design §3 and §4): the checks, the built-in grants, the effective grants and `can`.
import { describe, expect, it } from 'vitest';
import { builtInGrants, can, effective, grantsProblem, groupNameProblem, tagsProblem, type Grant } from '../src/access.js';

const grant = (tags: Record<string, string>, ...permissions: Grant['permissions']): Grant => ({ tags, permissions });
const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));

describe('tagsProblem (the router\'s rules and words)', () => {
  it('accepts no tags, 50 tags, Unicode letters and spaces', () => {
    expect(tagsProblem({})).toBeNull();
    expect(tagsProblem(many(50))).toBeNull();
    expect(tagsProblem({ 'équipe de paiement': 'Zoë Ünal', 'aws:team/a=b+c-d@e.f_g:h': '' })).toBeNull();
  });
  it('refuses what is not an object, 51 tags, bad keys and values, and the dormeto: prefix in any case', () => {
    expect(tagsProblem(null)).toBe('tags: an object of key and value strings');
    expect(tagsProblem([])).toBe('tags: an object of key and value strings');
    expect(tagsProblem(many(51))).toBe('tags: at most 50');
    expect(tagsProblem({ '': 'v' })).toBe('tag "": key of 1 to 128 characters');
    expect(tagsProblem({ ['k'.repeat(129)]: 'v' })).toBe(`tag "${'k'.repeat(129)}": key of 1 to 128 characters`);
    expect(tagsProblem({ ['k'.repeat(128)]: 'v' })).toBeNull();
    expect(tagsProblem({ a: 1 as unknown as string })).toBe('tag "a": value must be a string');
    expect(tagsProblem({ a: 'v'.repeat(257) })).toBe('tag "a": value of at most 256 characters');
    expect(tagsProblem({ a: 'v'.repeat(256) })).toBeNull();
    expect(tagsProblem({ 'a,b': 'v' })).toBe('tag "a,b": key characters: letters, digits, spaces and _ . : / = + - @');
    expect(tagsProblem({ a: 'x\ty' })).toBe('tag "a": value characters: letters, digits, spaces and _ . : / = + - @');
    expect(tagsProblem({ 'dormeto:x': 'v' })).toBe('tag "dormeto:x": the dormeto: prefix is reserved');
    expect(tagsProblem({ 'Dormeto:x': 'v' })).toBe('tag "Dormeto:x": the dormeto: prefix is reserved');
  });
  it('counts characters, not UTF-16 units', () => {
    expect(tagsProblem({ ['é'.repeat(128)]: 'v' })).toBeNull();
    // An emoji is a symbol, not a letter: refused for its characters, not its length.
    expect(tagsProblem({ a: '😀'.repeat(256) })).toBe('tag "a": value characters: letters, digits, spaces and _ . : / = + - @');
    expect(tagsProblem({ a: '𝒜'.repeat(256) })).toBeNull();
    expect(tagsProblem({ a: '𝒜'.repeat(257) })).toBe('tag "a": value of at most 256 characters');
  });
});

describe('groupNameProblem', () => {
  it('accepts 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit', () => {
    for (const name of ['payments', '2fa', 'a', 'team-a-1', 'a'.repeat(48)]) expect(groupNameProblem(name)).toBeNull();
  });
  it('refuses the others, and the dmt- prefix', () => {
    for (const name of ['', 'Payments', '-a', 'a_b', 'a b', 'a,b', 'a'.repeat(49), 'é']) expect(groupNameProblem(name)).toBe('group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit');
    expect(groupNameProblem('dmt-ops')).toBe('group name: the dmt- prefix is reserved for the built-in roles');
    expect(groupNameProblem(7 as unknown as string)).toBe('group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit');
  });
});

describe('grantsProblem', () => {
  it('accepts none, one with the empty selector, and 20', () => {
    expect(grantsProblem([])).toBeNull();
    expect(grantsProblem([grant({}, 'read')])).toBeNull();
    expect(grantsProblem(Array.from({ length: 20 }, () => grant({ team: 'a' }, 'read', 'wake', 'nap')))).toBeNull();
  });
  it('refuses 21, a non-array, bad tags, no permission, an unknown permission', () => {
    expect(grantsProblem(Array.from({ length: 21 }, () => grant({}, 'read')))).toBe('grants: at most 20');
    expect(grantsProblem('x')).toBe('grants: an array');
    expect(grantsProblem([null])).toBe('grant 1: an object with tags and permissions');
    expect(grantsProblem([grant({}, 'read'), { tags: { 'a,b': 'v' }, permissions: ['read'] }])).toBe('grant 2: tag "a,b": key characters: letters, digits, spaces and _ . : / = + - @');
    expect(grantsProblem([{ tags: {}, permissions: [] }])).toBe('grant 1: permissions: at least one of read, wake, nap');
    expect(grantsProblem([{ tags: {}, permissions: ['delete'] }])).toBe('grant 1: permissions: at least one of read, wake, nap');
    expect(grantsProblem([{ permissions: ['read'] }])).toBe('grant 1: tags: an object of key and value strings');
  });
});

describe('builtInGrants', () => {
  it('gives every workload by role, and nothing to a member', () => {
    expect(builtInGrants('viewer')).toEqual([grant({}, 'read')]);
    expect(builtInGrants('operator')).toEqual([grant({}, 'read', 'wake', 'nap')]);
    expect(builtInGrants('admin')).toEqual([grant({}, 'read', 'wake', 'nap')]);
    expect(builtInGrants('member')).toEqual([]);
  });
});

describe('can', () => {
  it('the empty selector matches every workload, tagged or not; a non-empty one never an untagged workload', () => {
    const all = [grant({}, 'read')];
    expect(can(all, undefined, 'read')).toBe(true);
    expect(can(all, {}, 'read')).toBe(true);
    expect(can(all, { team: 'a' }, 'read')).toBe(true);
    const team = [grant({ team: 'a' }, 'read')];
    expect(can(team, undefined, 'read')).toBe(false);
    expect(can(team, {}, 'read')).toBe(false);
    expect(can(team, { team: 'a' }, 'read')).toBe(true);
    expect(can(team, { team: 'b' }, 'read')).toBe(false);
    expect(can(team, { Team: 'a' }, 'read')).toBe(false);
  });
  it('a two-key selector needs both', () => {
    const g = [grant({ team: 'a', env: 'prod' }, 'read')];
    expect(can(g, { team: 'a' }, 'read')).toBe(false);
    expect(can(g, { team: 'a', env: 'dev' }, 'read')).toBe(false);
    expect(can(g, { team: 'a', env: 'prod', extra: 'x' }, 'read')).toBe(true);
  });
  it('wake and nap imply read, and nothing else', () => {
    const wake = [grant({ team: 'a' }, 'wake')];
    expect(can(wake, { team: 'a' }, 'read')).toBe(true);
    expect(can(wake, { team: 'a' }, 'wake')).toBe(true);
    expect(can(wake, { team: 'a' }, 'nap')).toBe(false);
    expect(can([grant({}, 'read')], {}, 'wake')).toBe(false);
  });
  it('the union of grants allows what any of them allows', () => {
    const grants = [grant({ team: 'a' }, 'read'), grant({ team: 'a' }, 'nap'), grant({ team: 'b' }, 'wake')];
    expect(can(grants, { team: 'a' }, 'nap')).toBe(true);
    expect(can(grants, { team: 'a' }, 'wake')).toBe(false);
    expect(can(grants, { team: 'b' }, 'wake')).toBe(true);
    expect(can([], { team: 'a' }, 'read')).toBe(false);
  });
});

describe('effective', () => {
  const groups = [[grant({ team: 'a' }, 'read', 'wake')], [grant({ team: 'b' }, 'nap')]];
  it('adds the built-in grant and the groups\' grants', () => {
    expect(effective('viewer', groups, true)).toEqual([grant({}, 'read'), ...groups.flat()]);
    expect(effective('member', groups, true)).toEqual(groups.flat());
    expect(effective('member', [], true)).toEqual([]);
  });
  it('without the multi-factor session where it is required, keeps read only', () => {
    expect(effective('operator', groups, false)).toEqual([grant({}, 'read'), grant({ team: 'a' }, 'read'), grant({ team: 'b' }, 'read')]);
    expect(effective('member', groups, false)).toEqual([grant({ team: 'a' }, 'read'), grant({ team: 'b' }, 'read')]);
  });
});
