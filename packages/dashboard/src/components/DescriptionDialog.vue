<script setup lang="ts">
// Write a description (Markdown): a text area with a counter out of 4,000 characters (code points of the trimmed text, as
// the API counts), a preview of the drawn text, Save, Clear (when one exists, after a confirmation: nothing keeps the old
// text) and Cancel. The API's refusal shows here; the dialog stays open, and cannot be closed while it saves.
import { computed, ref, watch } from 'vue';
import { mdiTextBoxOutline } from '@mdi/js';
import { renderMarkdown } from '../markdown';

const MAX = 4000;
const props = defineProps<{ modelValue: boolean; subject: string; text: string; exists: boolean; saving?: boolean; error?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; save: [string]; clear: [] }>();
const draft = ref('');
const tab = ref<'write' | 'preview'>('write');
const confirmClear = ref(false);
// The refusal of this opening's attempts only: the parent keeps the last one until its next write.
const shownError = ref('');
watch(() => props.error, (error) => { shownError.value = error ?? ''; });
watch(() => props.modelValue, (open) => { if (open) { draft.value = props.text; tab.value = 'write'; shownError.value = ''; } });
// The API trims first: surrounding blank space does not count against the limit, and a blank text is Clear's job.
const trimmed = computed(() => draft.value.trim());
const count = computed(() => [...trimmed.value].length);
const tooLong = computed(() => count.value > MAX);
const drawn = computed(() => renderMarkdown(draft.value));
const Drawn = () => drawn.value;
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="640" :persistent="saving" @update:model-value="emit('update:modelValue', $event)">
    <v-card data-test="description-dialog" :title="`Description of ${subject}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiTextBoxOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <v-tabs v-model="tab" density="compact" class="mb-3">
          <v-tab value="write">Write</v-tab>
          <v-tab value="preview">Preview</v-tab>
        </v-tabs>
        <v-textarea v-show="tab === 'write'" v-model="draft" data-test="description-text" label="Markdown" rows="10" auto-grow max-rows="20" hide-details autofocus />
        <div v-if="tab === 'write'" class="d-flex justify-end text-body-small mt-1" :class="tooLong ? 'text-error' : 'text-medium-emphasis'" data-test="description-count">{{ count.toLocaleString('en-US') }} / 4,000</div>
        <div v-else class="dm-preview dm-md" data-test="description-preview">
          <Drawn />
          <span v-if="!trimmed" class="text-medium-emphasis">Nothing to preview.</span>
        </div>
        <p class="mt-3 mb-0 text-body-small text-medium-emphasis">Headings, lists, quotes, code, bold, italic and https links. Anything else shows as written.</p>
        <v-alert v-if="shownError" type="error" variant="tonal" density="compact" class="mt-3" data-test="description-error" :text="shownError" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-btn v-if="exists" variant="text" color="error" :disabled="saving" @click="confirmClear = true">Clear</v-btn>
        <v-spacer />
        <v-btn variant="text" :disabled="saving" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="saving || !trimmed || tooLong" @click="emit('save', trimmed)">Save</v-btn>
      </v-card-actions>
    </v-card>
    <v-dialog v-model="confirmClear" max-width="440">
      <v-card title="Remove the description?">
        <v-card-text class="text-medium-emphasis">It cannot be recovered.</v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="confirmClear = false">Keep it</v-btn>
          <v-btn data-test="confirm-clear" color="error" variant="flat" @click="confirmClear = false; emit('clear')">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<style scoped>
.dm-preview { min-height: 160px; max-height: 420px; overflow: auto; padding: 8px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
</style>
