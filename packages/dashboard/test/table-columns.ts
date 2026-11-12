// Every exported column of a view's table says something for a row (tables design §5): a column's text is what search
// reads and an export prints, so a column with a cell of its own but no text, and no field of its key, exports nothing.
// The views' tests give a sample row with every fact set.
import { expect } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import type { Component } from 'vue';
import DmTable from '../src/components/DmTable.vue';
import { cellText, type DmExport, type DmHeader } from '../src/table';

// Each exported column's text for the row, by the column's title; the table is the one exported as `view`.
export function columnTexts<T>(wrapper: VueWrapper, view: string, row: T | ((items: T[]) => T)): Record<string, string> {
  type Props = { exported: DmExport; headers: DmHeader<T>[]; items: T[] };
  const tables = wrapper.findAllComponents(DmTable as unknown as Component).map((t) => t.props() as unknown as Props);
  const table = tables.find((t) => t.exported.name === view);
  expect(table, `a table exported as ${view}`).toBeDefined();
  const { headers, items } = table!;
  const sample = typeof row === 'function' ? (row as (rows: T[]) => T)(items) : row;
  expect(sample, 'the sample row').toBeDefined();
  return Object.fromEntries(headers.filter((h) => h.export !== false).map((h) => [h.title, cellText(h, sample)]));
}

// Each exported column says something for the row; the texts, for more checks.
export function expectEveryColumnSaid<T>(wrapper: VueWrapper, view: string, row: T | ((items: T[]) => T)): Record<string, string> {
  const texts = columnTexts(wrapper, view, row);
  for (const [title, text] of Object.entries(texts)) expect(text, `the text of the column ${title}`).not.toBe('');
  return texts;
}
