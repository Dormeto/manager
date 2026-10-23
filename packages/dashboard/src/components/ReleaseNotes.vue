<script lang="ts">
// A release's notes, drawn from Markdown by the shared renderer (src/markdown.ts), which makes no HTML from the text: the
// notes come from releases and may be hostile. A paragraph's lines join with spaces, as the notes are written.
import { defineComponent, h } from 'vue';
import { renderMarkdown } from '../markdown';

export default defineComponent({
  name: 'ReleaseNotes',
  props: { notes: { type: String, required: true } },
  setup: (props) => () => h('div', { class: 'dm-md' }, renderMarkdown(props.notes, { joinLines: true })),
});
</script>
