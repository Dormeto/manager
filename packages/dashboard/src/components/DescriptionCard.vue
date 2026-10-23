<script setup lang="ts">
// The description of a router or a workload (Markdown, drawn safely by src/markdown.ts): the text, who wrote it and when,
// and for whoever may write it a dialog. `description` undefined: the manager could not read it (a store error, or a manager
// before 0.19.0): the card shows nothing, never an invitation to write over a text that may exist. The parent saves and
// reports through `saving` and `error`; the dialog closes when a save ends without an error.
import { computed, ref, watch } from 'vue';
import { mdiPencilOutline, mdiTextBoxOutline } from '@mdi/js';
import { relative } from '../format';
import { renderMarkdown } from '../markdown';
import { useNow } from '../now';
import type { DescriptionInfo } from '../types';
import DescriptionDialog from './DescriptionDialog.vue';

const props = defineProps<{ description: DescriptionInfo | null | undefined; canEdit: boolean; subject?: string; saving?: boolean; error?: string }>();
const emit = defineEmits<{ save: [string]; clear: [] }>();
const now = useNow();
const open = ref(false);
watch(() => props.saving, (saving, was) => { if (was && !saving && !props.error) open.value = false; });
const Drawn = () => renderMarkdown(props.description?.text ?? '');
const footer = computed(() => (props.description ? `— ${props.description.by}, ${relative(props.description.at, now.value)}` : ''));
</script>

<template>
  <v-card v-if="description !== undefined" data-test="description-card" title="Description">
    <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiTextBoxOutline" size="18" /></v-avatar></template>
    <template v-if="canEdit" #append>
      <v-btn data-test="edit-description" :prepend-icon="mdiPencilOutline" variant="text" size="small" @click="open = true">{{ description ? 'Edit' : 'Add a description' }}</v-btn>
    </template>
    <v-card-text v-if="!description" class="text-medium-emphasis">No description</v-card-text>
    <template v-else>
      <v-card-text class="dm-md" data-test="description-text-drawn"><Drawn /></v-card-text>
      <v-card-text class="pt-0 text-body-small text-medium-emphasis" data-test="description-by">{{ footer }}</v-card-text>
    </template>
    <DescriptionDialog v-model="open" :subject="subject ?? ''" :text="description?.text ?? ''" :exists="!!description" :saving="saving" :error="error"
      @save="emit('save', $event)" @clear="emit('clear')" />
  </v-card>
</template>
