<script setup lang="ts">
// One criterion: dimension rows (values as text, parsed on input), a note, and a menu to add a dimension.
import { reactive, watch } from 'vue';
import { mdiClose, mdiPlus } from '@mdi/js';
import type { Criterion } from '@dormeto/discovery/types';
import { availableDimensions, dimensionOf, formatDimension, removeDimension, setDimension, usedDimensions, type DimensionKey } from '../discovery';

const props = defineProps<{ modelValue: Criterion; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [Criterion] }>();

// Text being typed per dimension: re-formatting it on every keystroke would eat separators.
const texts = reactive<Partial<Record<DimensionKey, string>>>({});
watch(() => props.modelValue, (c) => {
  for (const key of usedDimensions(c)) {
    const typed = texts[key];
    if (typed === undefined || JSON.stringify(setDimension({}, key, typed)[key]) !== JSON.stringify(c[key])) texts[key] = formatDimension(c, key);
  }
}, { immediate: true, deep: true });

function edit(key: DimensionKey, text: string) {
  texts[key] = text;
  emit('update:modelValue', setDimension(props.modelValue, key, text));
}
function add(key: DimensionKey) {
  texts[key] = '';
  emit('update:modelValue', setDimension(props.modelValue, key, ''));
}
function remove(key: DimensionKey) {
  delete texts[key];
  emit('update:modelValue', removeDimension(props.modelValue, key));
}
function note(text: string) {
  const { note: _, ...rest } = props.modelValue;
  emit('update:modelValue', text ? { ...rest, note: text } : rest);
}
</script>

<template>
  <div class="criterion">
    <div v-for="key in usedDimensions(modelValue)" :key="key" class="dimension-row">
      <span class="dimension">{{ dimensionOf(key).label }}</span>
      <v-text-field :model-value="texts[key]" :data-dimension="key" :hint="dimensionOf(key).hint" :placeholder="dimensionOf(key).hint"
        density="compact" variant="outlined" hide-details="auto" :disabled="disabled" class="dimension-value" @update:model-value="(v: string) => edit(key, v)" />
      <v-btn :icon="mdiClose" :data-remove="key" size="small" variant="text" :disabled="disabled" :aria-label="`Remove ${dimensionOf(key).label}`" @click="remove(key)" />
    </div>
    <p v-if="!usedDimensions(modelValue).length" class="text-body-small text-medium-emphasis mb-2">No condition: matches every account, region and rule.</p>
    <div class="criterion-foot">
      <v-menu v-if="!disabled && availableDimensions(modelValue).length">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" :prepend-icon="mdiPlus" size="small" variant="tonal">Condition</v-btn>
        </template>
        <v-list density="compact">
          <v-list-item v-for="key in availableDimensions(modelValue)" :key="key" :title="dimensionOf(key).label" :subtitle="dimensionOf(key).hint" @click="add(key)" />
        </v-list>
      </v-menu>
      <v-text-field :model-value="modelValue.note ?? ''" label="Note" density="compact" variant="underlined" hide-details :disabled="disabled"
        class="criterion-note" @update:model-value="note" />
    </div>
  </div>
</template>

<style scoped>
.dimension-row { display: grid; grid-template-columns: 128px minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-bottom: 8px; }
.dimension { font: 500 0.68rem/1.3 var(--dm-mono); letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.72; }
.criterion-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.criterion-note { flex: 0 1 280px; min-width: 160px; }
@media (max-width: 600px) {
  .dimension-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
  .dimension { grid-column: 1 / -1; }
}
</style>
