// The tables' search and sort (tables design §5): what DmTable applies to a client table, the same rows and order on the
// screen and in an export.
import { describe, expect, it } from 'vitest';
import { cellText, searchRows, sortRows, type DmHeader } from '../src/table';

interface Row { id: string; name?: string | null; n?: number | string | null; at?: Date; group?: string }
const ids = (rows: Row[]) => rows.map((r) => r.id);
const by = (key: string, order: 'asc' | 'desc' = 'asc') => [{ key, order }];

describe('sortRows', () => {
  const headers: DmHeader<Row>[] = [{ title: 'Name', key: 'name' }, { title: 'N', key: 'n' }];

  it('sorts numbers and numeric strings as numbers, not as words', () => {
    const rows: Row[] = [{ id: 'a', n: '10' }, { id: 'b', n: 9 }, { id: 'c', n: '100' }, { id: 'd', n: -2 }];
    expect(ids(sortRows(rows, headers, by('n')))).toEqual(['d', 'b', 'a', 'c']);
    expect(ids(sortRows(rows, headers, by('n', 'desc')))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('puts nothing (undefined, null, empty text) first going up and last going down, in their order', () => {
    const rows: Row[] = [{ id: 'x', name: 'beta' }, { id: 'u' }, { id: 'n', name: null }, { id: 'e', name: '' }, { id: 'y', name: 'alpha' }];
    expect(ids(sortRows(rows, headers, by('name')))).toEqual(['u', 'n', 'e', 'y', 'x']);
    expect(ids(sortRows(rows, headers, by('name', 'desc')))).toEqual(['x', 'y', 'u', 'n', 'e']);
  });

  it('sorts words by the locale, case aside, keeping the order of rows that tie', () => {
    const rows: Row[] = [{ id: '1', name: 'b' }, { id: '2', name: 'A' }, { id: '3', name: 'a' }, { id: '4', name: 'B' }, { id: '5', name: 'é' }];
    expect(ids(sortRows(rows, headers, by('name')))).toEqual(['2', '3', '1', '4', '5']);
    expect(ids(sortRows(rows, headers, by('name', 'desc')))).toEqual(['5', '1', '4', '2', '3']);
  });

  it('sorts on a second key where the first ties', () => {
    const rows: Row[] = [{ id: '1', group: 'b', n: 2 }, { id: '2', group: 'a', n: 2 }, { id: '3', group: 'b', n: 1 }, { id: '4', group: 'a', n: 1 }];
    expect(ids(sortRows(rows, headers, [{ key: 'group', order: 'asc' }, { key: 'n', order: 'desc' }]))).toEqual(['2', '4', '1', '3']);
  });

  it('sorts dates by their time, and on what a header\'s value gives', () => {
    const at: DmHeader<Row> = { title: 'At', key: 'when', value: (r) => r.at };
    const rows: Row[] = [{ id: 'late', at: new Date('2026-11-12T10:00:00Z') }, { id: 'early', at: new Date('2026-01-02T10:00:00Z') }, { id: 'mid', at: new Date('2026-06-01T00:00:00Z') }];
    expect(ids(sortRows(rows, [at], by('when')))).toEqual(['early', 'mid', 'late']);
    expect(ids(sortRows(rows, [at], by('when', 'desc')))).toEqual(['late', 'mid', 'early']);
  });

  it('uses a header\'s sort on the values, and its sortRaw on the rows, the order reversed going down', () => {
    const length: DmHeader<Row> = { title: 'Name', key: 'name', sort: (a, b) => String(a).length - String(b).length };
    const rows: Row[] = [{ id: 'long', name: 'abcd' }, { id: 'short', name: 'z' }, { id: 'mid', name: 'xy' }];
    expect(ids(sortRows(rows, [length], by('name')))).toEqual(['short', 'mid', 'long']);
    expect(ids(sortRows(rows, [length], by('name', 'desc')))).toEqual(['long', 'mid', 'short']);
    const raw: DmHeader<Row> = { title: 'Name', key: 'name', sortRaw: (a, b) => a.id.localeCompare(b.id) };
    expect(ids(sortRows(rows, [raw], by('name')))).toEqual(['long', 'mid', 'short']);
    expect(ids(sortRows(rows, [raw], by('name', 'desc')))).toEqual(['short', 'mid', 'long']);
  });

  it('leaves the rows as they are with no sort, or a sort turned off', () => {
    const rows: Row[] = [{ id: 'b', name: 'b' }, { id: 'a', name: 'a' }];
    expect(ids(sortRows(rows, headers, []))).toEqual(['b', 'a']);
    expect(ids(sortRows(rows, headers, [{ key: 'name', order: false }]))).toEqual(['b', 'a']);
  });
});

describe('searchRows', () => {
  // The state shown as an icon: its word is the column's text.
  const headers: DmHeader<Row>[] = [{ title: 'Name', key: 'name' }, { title: 'State', key: 'group', text: (r) => (r.group === 'S' ? 'napping' : 'awake') }];
  const rows: Row[] = [{ id: '1', name: 'Café du Port', group: 'S' }, { id: '2', name: 'cafe-api', group: 'A' }, { id: '3', name: 'shop', group: 'A' }];

  it('reads each column\'s text, not the raw value', () => {
    expect(ids(searchRows(rows, headers, 'napping'))).toEqual(['1']);
    expect(ids(searchRows(rows, headers, 'S'))).toEqual(['3']);
  });

  it('finds the query in one cell, case and accents aside, the spaces around it dropped', () => {
    expect(ids(searchRows(rows, headers, '  CAFE '))).toEqual(['1', '2']);
    expect(ids(searchRows(rows, headers, 'café'))).toEqual(['1', '2']);
    expect(ids(searchRows(rows, headers, 'du port'))).toEqual(['1']);
    expect(ids(searchRows(rows, headers, 'port napping'))).toEqual([]);
  });

  it('keeps every row for an empty search', () => {
    expect(ids(searchRows(rows, headers, ''))).toEqual(['1', '2', '3']);
    expect(ids(searchRows(rows, headers, null))).toEqual(['1', '2', '3']);
  });
});

describe('cellText', () => {
  it('is the column\'s text, else its field as text, else nothing', () => {
    expect(cellText({ title: 'N', key: 'n' }, { id: '1', n: 4 })).toBe('4');
    expect(cellText({ title: 'N', key: 'n' }, { id: '1', n: null })).toBe('');
    expect(cellText({ title: 'N', key: 'n', text: (r: Row) => `#${r.id}` }, { id: '1' })).toBe('#1');
  });
});
