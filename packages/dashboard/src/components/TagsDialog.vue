<script setup lang="ts">
// Edit a manager workload's tags (R11, administrators): Dormeto's own labels, never AWS tags. The router keeps them.
import { computed, ref, watch } from 'vue';
import { mdiTagMultipleOutline } from '@mdi/js';
import { rowsOf, rowsProblem, tagsOf, type TagRow, type Tags } from '../tags';
import TagsEditor from './TagsEditor.vue';

const props = defineProps<{ modelValue: boolean; tags: Tags | undefined; name: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Tags] }>();
const rows = ref<TagRow[]>([]);
watch(() => props.modelValue, (open) => { if (open) rows.value = rowsOf(props.tags); });
const problem = computed(() => rowsProblem(rows.value));
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Tags of ${name}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiTagMultipleOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4 text-medium-emphasis">Dormeto's own labels, not AWS tags: the groups' grants pick workloads by them. Nothing changes in AWS.</p>
        <TagsEditor v-model="rows" empty="No tags: only the built-in roles and the grants on every workload see this workload." />
        <v-alert v-if="problem" type="error" variant="tonal" density="compact" class="mt-2" :text="problem" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="Boolean(problem)" @click="emit('submit', tagsOf(rows))">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
