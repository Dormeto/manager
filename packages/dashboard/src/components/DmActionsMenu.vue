<script setup lang="ts">
// A "⋮" button and its menu list (tables design §5): a row's actions, or the table's (the exports first). A destructive
// action in its color; a disabled one stays focusable, says why in a tooltip (hover or keyboard focus) and does nothing.
import { computed } from 'vue';
import { mdiDotsVertical } from '@mdi/js';
import type { DmAction } from '../table';

export type MenuAction = DmAction & { test?: string };
type Entry = { kind: 'divider'; key: string } | { kind: 'group'; key: string; title: string } | { kind: 'action'; key: string; action: MenuAction };

const props = withDefaults(defineProps<{ actions: MenuAction[]; lead?: MenuAction[]; label: string; test: string; busy?: boolean }>(), { lead: () => [], busy: false });

// The lead (the exports), a line, then the actions; within them a line between groups, a group's name above its actions.
const entries = computed(() => {
  const out: Entry[] = props.lead.map((action, i) => ({ kind: 'action', key: `lead-${i}`, action }));
  props.actions.forEach((action, i) => {
    const previous = props.actions[i - 1];
    const changed = i === 0 || previous?.group !== action.group;
    if (changed && out.length) out.push({ kind: 'divider', key: `line-${i}` });
    if (changed && action.group) out.push({ kind: 'group', key: `group-${i}`, title: action.group });
    out.push({ kind: 'action', key: `action-${i}`, action });
  });
  return out;
});

function choose(event: Event, action: MenuAction) {
  // A disabled action keeps the menu open: its reason is the tooltip.
  if (action.disabled) {
    event.stopPropagation();
    return;
  }
  action.run();
}
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props: menu }">
      <v-btn v-bind="menu" :icon="mdiDotsVertical" variant="text" size="small" density="comfortable" :loading="busy" :aria-label="label" :data-test="test" class="dm-actions-btn" @click.stop />
    </template>
    <v-list density="compact" min-width="230" class="dm-actions">
      <template v-for="e in entries" :key="e.key">
        <v-divider v-if="e.kind === 'divider'" class="my-1" />
        <v-list-subheader v-else-if="e.kind === 'group'">{{ e.title }}</v-list-subheader>
        <v-tooltip v-else location="start" max-width="320" open-on-focus :disabled="!e.action.help" :text="e.action.help">
          <template #activator="{ props: tip }">
            <v-list-item v-bind="tip" :title="e.action.title" :prepend-icon="e.action.icon" :base-color="e.action.color" :data-test="e.action.test"
              :class="{ 'dm-actions__item--disabled': e.action.disabled }" :aria-disabled="e.action.disabled ? 'true' : undefined" @click="choose($event, e.action)" />
          </template>
        </v-tooltip>
      </template>
    </v-list>
  </v-menu>
</template>

<style scoped>
.dm-actions :deep(.v-list-subheader) { font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; min-height: 30px; }
.dm-actions__item--disabled { opacity: var(--v-disabled-opacity, 0.5); cursor: default; }
</style>
