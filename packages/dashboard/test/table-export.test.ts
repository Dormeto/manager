// The tables' exports (tables design §5): the CSV's bytes, the file's name, the byte order mark at download, the PDF's text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csv, download, fileName, pdf, winAnsi } from '../src/table-export';

describe('csv', () => {
  it('writes RFC 4180: a header line, commas between cells, CRLF after each line', () => {
    expect(csv(['Name', 'State'], [['web', 'ASLEEP'], ['api', 'AWAKE']])).toBe('Name,State\r\nweb,ASLEEP\r\napi,AWAKE\r\n');
  });

  it('quotes a cell holding a comma, a quote or a line break, its quotes doubled', () => {
    expect(csv(['A'], [['compute 10%, databases 20%'], ['say "hi"'], ['two\nlines'], ['cr\rhere']]))
      .toBe('A\r\n"compute 10%, databases 20%"\r\n"say ""hi"""\r\n"two\nlines"\r\n"cr\rhere"\r\n');
  });

  it('prefixes a cell starting with =, +, - or @ with a quote, so a spreadsheet never runs it as a formula', () => {
    expect(csv(['A', 'B'], [['=HYPERLINK("x")', '+1'], ['-2', '@SUM(A1)'], ['a=b', 'x-y']]))
      .toBe('A,B\r\n"\'=HYPERLINK(""x"")",\'+1\r\n\'-2,\'@SUM(A1)\r\na=b,x-y\r\n');
  });

  it('writes the header line alone for an empty table', () => {
    expect(csv(['Name', 'State'], [])).toBe('Name,State\r\n');
  });
});

describe('fileName', () => {
  it('names the file dormeto-<view>-<YYYY-MM-DD>, the day of the browser', () => {
    expect(fileName('users', 'csv', new Date(2026, 10, 2, 23, 59))).toBe('dormeto-users-2026-11-02.csv');
    expect(fileName('audit', 'pdf', new Date(2026, 0, 31, 0, 1))).toBe('dormeto-audit-2026-01-31.pdf');
  });
});

describe('download', () => {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    vi.useRealTimers();
  });
  // The blob handed to the browser and the link clicked for it.
  function capture() {
    const blobs: Blob[] = [];
    const clicked: { name: string; href: string }[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}`; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ name: this.download, href: this.href }); });
    return { blobs, clicked, restore: () => click.mockRestore() };
  }
  const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

  it('adds the byte order mark to a CSV (Excel reads it as UTF-8), clicks a link named for the file, then lets the URL go', async () => {
    vi.useFakeTimers();
    const { blobs, clicked, restore } = capture();
    download('dormeto-users-2026-11-12.csv', 'text/csv;charset=utf-8', 'Name\r\né\r\n');
    restore();
    expect(clicked).toEqual([{ name: 'dormeto-users-2026-11-12.csv', href: 'blob:test/1' }]);
    expect(blobs[0]!.type).toBe('text/csv;charset=utf-8');
    expect((await bytes(blobs[0]!)).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blobs[0]!.arrayBuffer())).toBe('﻿Name\r\né\r\n');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
  });

  it('adds nothing to another file', async () => {
    const { blobs, restore } = capture();
    download('dormeto-users-2026-11-12.pdf', 'application/pdf', new Blob(['%PDF-1.3']));
    restore();
    expect((await bytes(blobs[0]!)).slice(0, 4)).toEqual([...'%PDF'].map((c) => c.charCodeAt(0)));
  });
});

describe('pdf', () => {
  it('makes an A4 landscape PDF: the title, the lines, the table, the page numbers', async () => {
    const file = await pdf({ title: 'Users', lines: ['Exported Nov 12, 2026 — 2 rows', 'Search: “ops”'], headers: ['Email', 'Role'], rows: [['ops@example.com', 'operator'], ['dev@example.com', 'member']] });
    expect(file.type).toBe('application/pdf');
    // Read as Windows-1252, the font's encoding: the dash and the quotes come back as written.
    const text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
    expect(text.startsWith('%PDF-')).toBe(true);
    // A4 landscape, in points.
    expect(text).toMatch(/\/MediaBox \[0 0 841\.8\d* 595\.2\d*\]/);
    for (const s of ['(Users)', '(Exported Nov 12, 2026 — 2 rows)', '(Search: “ops”)', '(Email)', '(ops@example.com)', '(member)', '(Page 1 of 1)']) expect(text).toContain(s);
  });
});

describe('winAnsi', () => {
  // The PDF's standard font reads Windows-1252: a character outside it would print as two wrong ones.
  it('writes the typographic characters as the PDF font\'s own, the others as a plain equivalent', () => {
    expect(winAnsi('a — b … “c” ’ é × ·')).toBe('a \x97 b \x85 \x93c\x94 \x92 é × ·');
    expect(winAnsi('x → y ≥ 2 ≤ 3 ✓')).toBe('x -> y >= 2 <= 3 ?');
  });
});
