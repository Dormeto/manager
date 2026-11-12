// A table's exports (tables design §5): a CSV (RFC 4180, UTF-8 with a byte order mark for Excel) and a PDF made in the
// browser by jspdf and jspdf-autotable, loaded only when a PDF is asked for. Nothing leaves the browser.

// A cell a spreadsheet would run as a formula (names and reasons are typed by users; OWASP's list: =, +, -, @, a tab, a
// carriage return): written after a quote. A plain number (-2, +3.5, -1,234.5) stays as it is, so it stays a number.
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

function field(value: string): string {
  const text = FORMULA.test(value) && !NUMBER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// RFC 4180: the header line, then a line per row, each ended by CRLF; no byte order mark (download adds it).
export function csv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((line) => `${line.map(field).join(',')}\r\n`).join('');
}

// The file handed to the browser; a CSV gets the byte order mark, by which Excel reads it as UTF-8.
export function download(name: string, mime: string, body: BlobPart): void {
  const parts: BlobPart[] = mime.startsWith('text/csv') ? ['\uFEFF', body] : [body];
  const url = URL.createObjectURL(new Blob(parts, { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let go of the file once the browser has it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const two = (n: number) => String(n).padStart(2, '0');
// dormeto-<view>-<YYYY-MM-DD>.<ext>, the day of the browser.
export const fileName = (view: string, ext: 'csv' | 'pdf', at = new Date()): string =>
  `dormeto-${view}-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}.${ext}`;

// The PDF's standard font reads Windows-1252: the typographic characters it has are written as its own codes, a few
// others as plain equivalents, the rest as "?" (a character beyond it would print as two wrong ones).
const CP1252: Record<string, string> = {
  '€': '\x80', '‚': '\x82', 'ƒ': '\x83', '„': '\x84', '…': '\x85', '†': '\x86', '‡': '\x87', 'ˆ': '\x88', '‰': '\x89', 'Š': '\x8a', '‹': '\x8b',
  'Œ': '\x8c', 'Ž': '\x8e', '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94', '•': '\x95', '–': '\x96', '—': '\x97', '˜': '\x98', '™': '\x99',
  'š': '\x9a', '›': '\x9b', 'œ': '\x9c', 'ž': '\x9e', 'Ÿ': '\x9f',
};
const PLAIN: Record<string, string> = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '≠': '!=', '−': '-', '\u202F': ' ', '\u2009': ' ', '\u00A0': ' ' };
const printable = (c: string) => Boolean(PLAIN[c] ?? CP1252[c]) || c.codePointAt(0)! < 0x80 || (c.codePointAt(0)! >= 0xa0 && c.codePointAt(0)! <= 0xff);
// A letter and its accent composed first (a decomposed é is the font's é).
export function winAnsi(text: string): string {
  let out = '';
  for (const c of text.normalize('NFC')) out += PLAIN[c] ?? CP1252[c] ?? (printable(c) ? c : '?');
  return out;
}
// How many characters of a text the font prints as "?".
const unprintable = (text: string) => [...text.normalize('NFC')].filter((c) => !printable(c)).length;

// A4 landscape: the title, the lines (when, the search and filters in force), the table, and page numbers.
// A line says how many characters the font could not print, which the CSV keeps.
export async function pdf(doc: { title: string; lines: string[]; headers: string[]; rows: string[][] }): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const missed = [doc.title, ...doc.lines, ...doc.headers, ...doc.rows.flat()].reduce((n, text) => n + unprintable(text), 0);
  const lines = missed === 0 ? doc.lines : [...doc.lines, missed === 1
    ? '1 character this PDF\'s font cannot print is shown as ?; the CSV export keeps it.'
    : `${missed} characters this PDF's font cannot print are shown as ?; the CSV export keeps them.`];
  const file = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const margin = 36;
  file.setProperties({ title: winAnsi(doc.title), creator: 'Dormeto' });
  file.setFont('helvetica', 'bold');
  file.setFontSize(15);
  file.text(winAnsi(doc.title), margin, margin + 8);
  file.setFont('helvetica', 'normal');
  file.setFontSize(9);
  file.setTextColor(90);
  let y = margin + 26;
  for (const line of lines) {
    for (const part of file.splitTextToSize(winAnsi(line), file.internal.pageSize.getWidth() - 2 * margin) as string[]) {
      file.text(part, margin, y);
      y += 12;
    }
  }
  autoTable(file, {
    head: [doc.headers.map(winAnsi)],
    body: doc.rows.map((row) => row.map(winAnsi)),
    startY: y + 4,
    margin: { top: margin, right: margin, bottom: margin + 10, left: margin },
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [3, 75, 128], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 247, 250] },
  });
  const pages = file.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    file.setPage(page);
    file.setFontSize(8);
    file.setTextColor(120);
    const { width, height } = { width: file.internal.pageSize.getWidth(), height: file.internal.pageSize.getHeight() };
    file.text(`Page ${page} of ${pages}`, width - margin, height - margin / 2, { align: 'right' });
    file.text(winAnsi(doc.title), margin, height - margin / 2);
  }
  return file.output('blob');
}
