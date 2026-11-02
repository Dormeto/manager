<script setup lang="ts">
// What a drag or a resize of a repeating window's occurrence changes, asked on the drop (the user, 2026-11-02): this occurrence
// alone or the whole series, each said in a line, or why it can't be. Cancel, Escape or a click outside puts the item back.
import { mdiCalendarEdit } from '@mdi/js';
import type { Edge, Edited, Scope } from '../drag';

export interface ScopeAsk { name: string; edge: Edge; before: string; after: string; occurrence: Edited; series: Edited }

defineProps<{ ask: ScopeAsk | null }>();
const emit = defineEmits<{ choose: [Scope | null] }>();
const line = (e: Edited) => ('problem' in e ? e.problem : e.summary);
const CHOICES: { scope: Scope; label: string }[] = [{ scope: 'occurrence', label: 'Only this occurrence' }, { scope: 'series', label: 'The whole series' }];
</script>

<template>
  <v-dialog :model-value="Boolean(ask)" max-width="520" @update:model-value="$event || emit('choose', null)">
    <v-card v-if="ask" data-test="scope-dialog" :title="ask.edge === 'move' ? 'Move a repeating window' : 'Change a repeating window'">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarEdit" size="20" /></v-avatar></template>
      <v-card-text>
        <p data-test="scope-change" class="mb-4"><strong>{{ ask.name }}</strong>: {{ ask.before }} → {{ ask.after }}</p>
        <div v-for="c in CHOICES" :key="c.scope" class="mb-3">
          <v-btn :data-test="`scope-${c.scope}`" block variant="tonal" color="primary" :disabled="'problem' in ask[c.scope]" @click="emit('choose', c.scope)">{{ c.label }}</v-btn>
          <div :data-test="`scope-${c.scope}-line`" class="text-body-small mt-1" :class="'problem' in ask[c.scope] ? 'text-error' : 'text-medium-emphasis'">{{ line(ask[c.scope]) }}</div>
        </div>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn data-test="scope-cancel" variant="text" @click="emit('choose', null)">Cancel</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
