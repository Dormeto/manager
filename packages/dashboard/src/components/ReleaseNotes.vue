<script lang="ts">
// A release's notes, as a minimal Markdown subset drawn with render functions: nothing here makes HTML from the text
// (the notes come from releases and may be hostile). Headings, lists, paragraphs, `code`, **bold** and [links](https://…);
// a link of any other scheme, and anything else, stays text.
import { defineComponent, h, type VNodeChild } from 'vue';

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): VNodeChild[] {
  const out: VNodeChild[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(h('code', m[1]));
    else if (m[2] !== undefined) out.push(h('strong', m[2]));
    else if (m[4]!.startsWith('https://')) out.push(h('a', { href: m[4], rel: 'noopener', target: '_blank' }, m[3]));
    else out.push(m[0]);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function render(notes: string): VNodeChild[] {
  const blocks: VNodeChild[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(h('p', inline(paragraph.join(' '))));
    if (items.length) blocks.push(h('ul', items.map((i) => h('li', inline(i)))));
    paragraph = [];
    items = [];
  };
  for (const line of notes.split('\n')) {
    const text = line.trim();
    const heading = /^(#{2,3})\s+(.+)$/.exec(text);
    const item = /^[-*]\s+(.+)$/.exec(text);
    if (!text) flush();
    else if (heading) {
      flush();
      blocks.push(h(heading[1] === '##' ? 'h4' : 'h5', { class: 'dm-notes__heading' }, inline(heading[2]!)));
    } else if (item) {
      if (paragraph.length) flush();
      items.push(item[1]!);
    } else if (items.length && /^\s/.test(line)) items[items.length - 1] += ` ${text}`;
    else {
      if (items.length) flush();
      paragraph.push(text);
    }
  }
  flush();
  return blocks;
}

export default defineComponent({
  name: 'ReleaseNotes',
  props: { notes: { type: String, required: true } },
  setup: (props) => () => h('div', { class: 'dm-notes' }, render(props.notes)),
});
</script>

<style>
.dm-notes { font-size: 0.9rem; line-height: 1.5; overflow-wrap: anywhere; }
.dm-notes p { margin: 0 0 8px; }
.dm-notes ul { margin: 0 0 8px; padding-left: 20px; }
.dm-notes .dm-notes__heading { margin: 10px 0 4px; font-size: 0.95rem; font-weight: 600; }
.dm-notes h5.dm-notes__heading { font-size: 0.9rem; }
.dm-notes code { padding: 1px 5px; border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.08); font-family: var(--dm-mono); font-size: 0.85em; }
.dm-notes a { color: rgb(var(--v-theme-primary)); }
</style>
