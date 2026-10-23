<script setup lang="ts">
// Write a description (Markdown): a text area with a counter out of 4,000 characters (code points, as the API counts), a
// preview of the drawn text, Save, Clear (when one exists) and Cancel. The API's refusal shows here; the dialog stays open.
import { computed, ref, watch } from 'vue';
import { mdiTextBoxOutline } from '@mdi/js';
import { renderMarkdown } from '../markdown';

const MAX = 4000;
const props = defineProps<{ modelValue: boolean; subject: string; text: string; exists: boolean; saving?: boolean; error?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; save: [string]; clear: [] }>();
const draft = ref('');
const tab = ref<'write' | 'preview'>('write');
watch(() => props.modelValue, (open) => { if (open) { draft.value = props.text; tab.value = 'write'; } });
const count = computed(() => [...draft.value].length);
// The API trims first: surrounding blank space does not count against the limit, and a blank text is Clear's job.
const trimmed = computed(() => draft.value.trim());
const tooLong = computed(() => [...trimmed.value].length > MAX);
const drawn = computed(() => renderMarkdown(draft.value));
const Drawn = () => drawn.value;
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="640" @update:model-value="emit('update:modelValue', $event)">
    <v-card data-test="description-dialog" :title="`Description of ${subject}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiTextBoxOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <v-tabs v-model="tab" density="compact" class="mb-3">
          <v-tab value="write">Write</v-tab>
          <v-tab value="preview">Preview</v-tab>
        </v-tabs>
        <v-textarea v-show="tab === 'write'" v-model="draft" data-test="description-text" label="Markdown" rows="10" auto-grow max-rows="20" hide-details autofocus />
        <div v-if="tab === 'write'" class="d-flex justify-end text-body-small mt-1" :class="tooLong ? 'text-error' : 'text-medium-emphasis'" data-test="description-count">{{ count }} / 4,000</div>
        <div v-else class="dm-preview dm-md" data-test="description-preview">
          <Drawn />
          <span v-if="!trimmed" class="text-medium-emphasis">Nothing to preview.</span>
        </div>
        <p class="mt-3 mb-0 text-body-small text-medium-emphasis">Headings, lists, quotes, code, bold, italic and https links. Anything else shows as written.</p>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3" data-test="description-error" :text="error" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-btn v-if="exists" variant="text" color="error" :disabled="saving" @click="emit('clear')">Clear</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="saving || !trimmed || tooLong" @click="emit('save', trimmed)">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-preview { min-height: 160px; max-height: 420px; overflow: auto; padding: 8px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
</style>
