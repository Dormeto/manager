// A description of a router or a workload (descriptions design §2): optional Markdown written by people, up to 4,000
// characters, shown by the manager and its CLI.
export const DESCRIPTION_MAX = 4000;
const SUMMARY_MAX = 120;

// Line feed and tab are the only control characters kept (a lone carriage return is refused: the API turns \r\n into \n first).
// Any control character (C0, DEL, C1 such as U+009B) other than line feed and tab.
const CONTROL = /[^\P{Cc}\n\t]/u;

export function descriptionProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'text must be a string';
  const trimmed = text.trim();
  if ([...trimmed].length > DESCRIPTION_MAX) return `text must be at most ${DESCRIPTION_MAX} characters`;
  if (CONTROL.test(trimmed)) return 'text must not contain control characters other than line feed and tab';
  return null;
}

// The list's one line: the first non-empty line as plain text, its leading heading, quote, list and number markers
// and the emphasis or code around it removed (one pair: not `**a** and **b**`), cut with an ellipsis.
export function summaryOf(text: string): string {
  let line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  for (let previous = ''; previous !== line;) {
    previous = line;
    line = line.replace(/^(#+\s*|>\s*|[-*+]\s+|\d+\.\s+)/, '').trim();
  }
  const wrapped = /^(\*\*|\*|`)(.+)\1$/.exec(line);
  if (wrapped && !wrapped[2]!.includes(wrapped[1]!)) line = wrapped[2]!;
  const chars = [...line];
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : line;
}
