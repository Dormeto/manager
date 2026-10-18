<script setup lang="ts">
// A command in a code block, with a button copying it.
import { onBeforeUnmount, ref } from 'vue';
import { mdiCheck, mdiContentCopy } from '@mdi/js';

const props = defineProps<{ command: string }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.command);
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    // No clipboard (an insecure page): the command stays selectable.
  }
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="dm-command d-flex align-center ga-2">
    <pre class="flex-grow-1"><code>{{ command }}</code></pre>
    <v-btn variant="text" size="small" density="comfortable" :prepend-icon="copied ? mdiCheck : mdiContentCopy" :aria-label="`Copy ${command}`" @click="copy">
      {{ copied ? 'Copied' : 'Copy' }}
    </v-btn>
  </div>
</template>

<style scoped>
.dm-command { padding: 4px 4px 4px 12px; border-radius: 8px; background: rgba(var(--v-theme-on-surface), 0.06); }
.dm-command pre { margin: 0; overflow-x: auto; font: 0.82rem/1.5 var(--dm-mono); }
.dm-command code { padding: 0; background: none; font: inherit; }
</style>
