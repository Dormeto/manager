<script setup lang="ts">
// The custom groups (R11): created, described and deleted by administrators, each with the grants its members act with.
// Membership is in the users' rows; a change of grants applies within a minute, a change of members at their next sign-in.
import { computed, ref } from 'vue';
import { mdiAccountGroupOutline, mdiDeleteOutline, mdiPencilOutline, mdiPlus } from '@mdi/js';
import { api } from '../api';
import { DESCRIPTION_MAX, GRANTS_MAX, grantRowsOf, grantRowsProblem, grantText, grantsOf, type Group, type GrantRow } from '../groups';
import { groupNameProblem } from '../tags';
import GrantEditor from './GrantEditor.vue';

const props = defineProps<{ groups: Group[]; users: { email: string; groups?: string[] }[] }>();
const emit = defineEmits<{ notice: [{ type: 'success' | 'error'; text: string }]; changed: [] }>();
const members = (name: string) => props.users.filter((u) => u.groups?.includes(name)).map((u) => u.email);

// The dialog: a new group (name asked) or an existing one (its description and grants).
const editing = ref<{ isNew: boolean; name: string; description: string; grants: GrantRow[] } | null>(null);
const deleting = ref<Group | null>(null);
const open = computed({ get: () => editing.value !== null, set: (v) => { if (!v) editing.value = null; } });
const nameProblem = computed(() => (editing.value?.isNew && editing.value.name ? groupNameProblem(editing.value.name) : null));
const problem = computed(() => {
  const e = editing.value;
  if (!e) return null;
  if (e.isNew && groupNameProblem(e.name)) return nameProblem.value ?? 'group name: required';
  if ([...e.description].length > DESCRIPTION_MAX) return `description: at most ${DESCRIPTION_MAX} characters`;
  return grantRowsProblem(e.grants);
});
const create = () => { editing.value = { isNew: true, name: '', description: '', grants: [] }; };
const edit = (g: Group) => { editing.value = { isNew: false, name: g.name, description: g.description, grants: grantRowsOf(g.grants) }; };

async function save() {
  const e = editing.value!;
  editing.value = null;
  try {
    const grants = grantsOf(e.grants);
    if (e.isNew) await api('/groups', { method: 'POST', body: JSON.stringify({ name: e.name, description: e.description.trim(), grants }) });
    else await api(`/groups/${encodeURIComponent(e.name)}`, { method: 'PUT', body: JSON.stringify({ description: e.description.trim(), grants }) });
    emit('notice', { type: 'success', text: e.isNew ? `Group ${e.name} created.` : `Group ${e.name} saved: its grants apply within a minute.` });
    emit('changed');
  } catch (err) {
    emit('notice', { type: 'error', text: (err as Error).message });
  }
}

async function remove() {
  const g = deleting.value!;
  deleting.value = null;
  try {
    await api(`/groups/${encodeURIComponent(g.name)}`, { method: 'DELETE' });
    emit('notice', { type: 'success', text: `Group ${g.name} deleted: its grants stop applying within a minute.` });
    emit('changed');
  } catch (err) {
    emit('notice', { type: 'error', text: (err as Error).message });
  }
}
</script>

<template>
  <v-card class="mb-4" data-test="groups">
    <v-card-item :prepend-icon="mdiAccountGroupOutline" title="Groups" subtitle="Members act with the grants of their groups: a tag selector and what it allows (read, wake, nap).">
      <template #append><v-btn data-test="new-group" color="primary" variant="tonal" size="small" :prepend-icon="mdiPlus" @click="create">New group</v-btn></template>
    </v-card-item>
    <v-card-text v-if="!groups.length" class="text-medium-emphasis">No group yet. A member with no group sees no workload.</v-card-text>
    <v-list v-else lines="three">
      <v-list-item v-for="g in groups" :key="g.name" data-test="group">
        <v-list-item-title class="font-weight-medium">{{ g.name }}</v-list-item-title>
        <v-list-item-subtitle v-if="g.description" class="text-wrap">{{ g.description }}</v-list-item-subtitle>
        <div class="dm-group__meta">
          <v-chip v-for="(grant, i) in g.grants" :key="i" data-test="grant" size="small" label variant="tonal" color="primary">{{ grantText(grant) }}</v-chip>
          <span v-if="!g.grants.length" class="text-body-small text-medium-emphasis">no grants</span>
        </div>
        <div class="text-body-small text-medium-emphasis mt-1">{{ members(g.name).length ? members(g.name).join(', ') : 'no members' }}</div>
        <template #append>
          <v-btn :data-test="`edit-group-${g.name}`" :icon="mdiPencilOutline" variant="text" size="small" :aria-label="`Edit ${g.name}`" @click="edit(g)" />
          <v-btn :data-test="`delete-group-${g.name}`" :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Delete ${g.name}`" @click="deleting = g" />
        </template>
      </v-list-item>
    </v-list>

    <v-dialog v-model="open" max-width="640" scrollable>
      <v-card v-if="editing" :title="editing.isNew ? 'New group' : `Group ${editing.name}`" :prepend-icon="mdiAccountGroupOutline" class="dm-dialog">
        <v-card-text>
          <v-text-field v-model="editing.name" label="Name" :disabled="!editing.isNew" autocomplete="off" :autofocus="editing.isNew"
            hint="Lower-case letters, digits and hyphens, up to 48; dmt- is reserved for the built-in roles." persistent-hint class="mb-3" />
          <v-text-field v-model="editing.description" label="Description" :counter="DESCRIPTION_MAX" class="mb-3" />
          <div class="dm-eyebrow mb-2">Grants (at most {{ GRANTS_MAX }})</div>
          <p class="text-body-small text-medium-emphasis mb-3">A workload is seen when a grant of one of the user's groups has all its tags on it; wake and nap include read. Tags are set on the workloads, not in AWS.</p>
          <GrantEditor v-model="editing.grants" />
          <v-alert v-if="problem" type="error" variant="tonal" density="compact" class="mt-3" :text="problem" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="editing = null">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :disabled="Boolean(problem)" @click="save">{{ editing.isNew ? 'Create' : 'Save' }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="deleting !== null" max-width="460" @update:model-value="deleting = null">
      <v-card :title="`Delete the group ${deleting?.name}?`" :prepend-icon="mdiDeleteOutline" class="dm-dialog">
        <v-card-text>
          Its grants stop applying within a minute, even while its members' sign-ins still name it.
          <template v-if="deleting && members(deleting.name).length"> Members: {{ members(deleting.name).join(', ') }}.</template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleting = null">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="remove">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.dm-group__meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dm-dialog :deep(.v-card-title) { white-space: normal; line-height: 1.3; }
</style>
