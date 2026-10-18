<script setup lang="ts">
// The rows of a tag editor (R11): a key and a value each, to add and remove. The parent keeps the rows and judges them with
// rowsProblem (tags.ts); an empty list is allowed, and says what it means where the parent has something to say.
import { mdiClose, mdiPlus } from '@mdi/js';
import type { TagRow } from '../tags';

const props = defineProps<{ modelValue: TagRow[]; disabled?: boolean; empty?: string }>();
const emit = defineEmits<{ 'update:modelValue': [TagRow[]] }>();
const set = (i: number, field: keyof TagRow, value: string) => emit('update:modelValue', props.modelValue.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
const remove = (i: number) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i));
const add = () => emit('update:modelValue', [...props.modelValue, { key: '', value: '' }]);
</script>

<template>
  <div class="dm-tags-editor" data-test="tags-editor">
    <p v-if="!modelValue.length && empty" class="text-body-small text-medium-emphasis mb-2">{{ empty }}</p>
    <div v-for="(row, i) in modelValue" :key="i" class="dm-tags-editor__row">
      <v-text-field :model-value="row.key" label="Key" density="compact" hide-details :disabled="disabled" @update:model-value="set(i, 'key', $event)" />
      <v-text-field :model-value="row.value" label="Value" density="compact" hide-details :disabled="disabled" @update:model-value="set(i, 'value', $event)" />
      <v-btn :icon="mdiClose" variant="text" size="small" :disabled="disabled" :aria-label="`Remove the tag ${row.key}`" @click="remove(i)" />
    </div>
    <v-btn data-test="add-tag" :prepend-icon="mdiPlus" variant="text" size="small" :disabled="disabled" @click="add">Add a tag</v-btn>
  </div>
</template>

<style scoped>
.dm-tags-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-bottom: 10px; }
</style>
