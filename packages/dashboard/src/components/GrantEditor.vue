<script setup lang="ts">
// The grants of a group (R11): rows of a tag selector (all its tags must match; none: every workload) and the permissions it
// gives. wake and nap imply read, which is ticked for them.
import { mdiDeleteOutline, mdiPlus } from '@mdi/js';
import { GRANTS_MAX, PERMISSIONS, type GrantRow, type Permission } from '../groups';
import TagsEditor from './TagsEditor.vue';

const props = defineProps<{ modelValue: GrantRow[] }>();
const emit = defineEmits<{ 'update:modelValue': [GrantRow[]] }>();
const update = (i: number, change: Partial<GrantRow>) => emit('update:modelValue', props.modelValue.map((g, j) => (j === i ? { ...g, ...change } : g)));
const remove = (i: number) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i));
const add = () => emit('update:modelValue', [...props.modelValue, { rows: [], permissions: [] }]);
const implied = (g: GrantRow, p: Permission) => p === 'read' && (g.permissions.includes('wake') || g.permissions.includes('nap'));
const ticked = (g: GrantRow, p: Permission) => g.permissions.includes(p) || implied(g, p);
function toggle(i: number, g: GrantRow, p: Permission, on: boolean | null) {
  update(i, { permissions: on ? [...new Set([...g.permissions, p])] : g.permissions.filter((x) => x !== p) });
}
</script>

<template>
  <div data-test="grant-editor">
    <p v-if="!modelValue.length" class="text-body-small text-medium-emphasis mb-2">No grants: the members of this group see no workload through it.</p>
    <v-sheet v-for="(g, i) in modelValue" :key="i" border rounded class="pa-3 mb-3" data-test="grant-row">
      <div class="d-flex align-center mb-2">
        <span class="dm-eyebrow">Grant {{ i + 1 }}</span>
        <v-spacer />
        <v-btn :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Remove grant ${i + 1}`" @click="remove(i)" />
      </div>
      <TagsEditor :model-value="g.rows" empty="Every workload (no tag to match)." @update:model-value="update(i, { rows: $event })" />
      <div class="d-flex flex-wrap ga-4">
        <v-checkbox v-for="p in PERMISSIONS" :key="p" :data-test="`perm-${p}`" :label="p" :model-value="ticked(g, p)" :disabled="implied(g, p)" density="compact" hide-details
          @update:model-value="toggle(i, g, p, $event)" />
      </div>
    </v-sheet>
    <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" :disabled="modelValue.length >= GRANTS_MAX" @click="add">Add a grant</v-btn>
  </div>
</template>
