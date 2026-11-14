<script setup lang="ts">
// The custom groups (R11), in a view of their own (the user, 2026-11-15): created, described and deleted by administrators,
// each with the grants its members act with, as a table (tables design §5). Membership stays in the users' rows (Users);
// a change of grants applies within a minute, a change of members at their next sign-in.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { mdiAccountGroupOutline, mdiDeleteOutline, mdiPencilOutline, mdiPlus } from '@mdi/js';
import { api } from '../api';
import { exactTime, relative } from '../format';
import { DESCRIPTION_MAX, GRANTS_MAX, grantRowsOf, grantRowsProblem, grantText, grantsOf, type Group, type GrantRow } from '../groups';
import { useNow } from '../now';
import type { DmAction, DmHeader } from '../table';
import { groupNameProblem } from '../tags';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import DmTable from '../components/DmTable.vue';
import GrantEditor from '../components/GrantEditor.vue';
import NoticeAlert, { type Notice } from '../components/NoticeAlert.vue';
import PageTitle from '../components/PageTitle.vue';

const now = useNow();
const route = useRoute();
const groups = ref<Group[]>([]);
// Each user's groups, for the members' count (null: the users could not be read).
const users = ref<{ email: string; groups?: string[] }[] | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const notice = ref<Notice | null>(null);

async function load() {
  loading.value = true;
  try {
    groups.value = (await api<{ groups: Group[] }>('/groups')).groups;
    error.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
    loaded.value = true;
  }
  // The groups show without their members when the users cannot be read, and the page says so.
  try {
    users.value = (await api<{ users: { email: string; groups?: string[] }[] }>('/users')).users;
  } catch (err) {
    users.value = null;
    notice.value = { type: 'error', text: `The members could not be read: ${(err as Error).message}` };
  }
}

const members = (name: string) => (users.value ?? []).filter((u) => u.groups?.includes(name)).map((u) => u.email);
const memberCount = (g: Group) => (users.value ? members(g.name).length : null);
const grantsText = (g: Group) => (g.grants.length ? g.grants.map(grantText).join('; ') : 'no grants');
const changedText = (g: Group) => (g.updatedAt ? `${g.updatedAt}${g.updatedBy ? ` by ${g.updatedBy}` : ''}` : '');

// Each column's words: what search reads and an export prints. Sorted by name.
const headers: DmHeader<Group>[] = [
  { title: 'Name', key: 'name' },
  { title: 'Description', key: 'description' },
  { title: 'Grants', key: 'grants', sortable: false, text: grantsText },
  { title: 'Members', key: 'members', align: 'end', value: (g) => memberCount(g) ?? -1, text: (g) => String(memberCount(g) ?? '') },
  { title: 'Changed', key: 'updatedAt', text: changedText },
];
const BY_NAME = [{ key: 'name', order: 'asc' as const }];

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

// A group a link names (?group=, a user's group in Users) opens in its dialog, on the page that holds it, once the list has it.
const table = ref<{ reveal: (value: unknown) => Promise<boolean> } | null>(null);
const named = ref<string | null>(null);
watch(() => route.query.group, (name) => { if (typeof name === 'string' && name) named.value = name; }, { immediate: true });
watch([named, groups, table], async ([name]) => {
  const group = groups.value.find((g) => g.name === name);
  if (!group || !table.value) return;
  named.value = null;
  await table.value.reveal(group.name);
  edit(group);
});

async function save() {
  const e = editing.value!;
  editing.value = null;
  try {
    const grants = grantsOf(e.grants);
    if (e.isNew) await api('/groups', { method: 'POST', body: JSON.stringify({ name: e.name, description: e.description.trim(), grants }) });
    else await api(`/groups/${encodeURIComponent(e.name)}`, { method: 'PUT', body: JSON.stringify({ description: e.description.trim(), grants }) });
    notice.value = { type: 'success', text: e.isNew ? `Group ${e.name} created.` : `Group ${e.name} saved: its grants apply within a minute.` };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function remove() {
  const g = deleting.value!;
  deleting.value = null;
  try {
    await api(`/groups/${encodeURIComponent(g.name)}`, { method: 'DELETE' });
    notice.value = { type: 'success', text: `Group ${g.name} deleted: its grants stop applying within a minute.` };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

const actions = (g: Group): DmAction[] => [
  { title: 'Edit', icon: mdiPencilOutline, run: () => edit(g) },
  { title: 'Delete', icon: mdiDeleteOutline, color: 'error', run: () => { deleting.value = g; } },
];
// A row opens its group's dialog (a link or a button in it does its own).
const clickRow = (_: Event, { item }: { item: Group }) => edit(item);

load();
</script>

<template>
  <div>
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <PageTitle eyebrow="Administration" title="Groups" />
      <v-spacer />
      <v-btn data-test="new-group" color="primary" variant="flat" :prepend-icon="mdiPlus" @click="create">New group</v-btn>
    </div>
    <p class="dm-lead text-medium-emphasis mt-n2 mb-6">Members act with the grants of their groups: a tag selector and what it allows (read, wake, nap). Who holds a
      group is set on each user, in Users.</p>
    <NoticeAlert v-if="notice" :notice="notice" @close="notice = null" />
    <v-alert v-if="error" type="error" class="mb-4" :text="error" />
    <v-card class="dm-groups">
      <DmTable ref="table" :headers="headers" :items="groups" :loading="loading && !loaded" item-value="name" :sort-by="BY_NAME" :actions="actions"
        :exported="{ name: 'groups', title: 'Groups' }" @click:row="clickRow">
        <template #loading><DmLoader label="Reading the groups…" :size="48" /></template>
        <template #no-data>
          <div class="dm-calm" data-test="groups-empty">
            <DmLogo state="sleep" :size="40" />
            <span class="text-medium-emphasis">No group yet. A member with no group sees no workload.</span>
            <v-btn color="primary" variant="tonal" size="small" :prepend-icon="mdiPlus" @click="create">New group</v-btn>
          </div>
        </template>
        <template #[`item.name`]="{ item }">
          <div class="dm-group">
            <v-avatar color="primary" variant="tonal" rounded="lg" size="34" class="dm-group__icon"><v-icon :icon="mdiAccountGroupOutline" size="18" aria-hidden="true" /></v-avatar>
            <span class="dm-group__name">{{ item.name }}</span>
          </div>
        </template>
        <template #[`item.description`]="{ item }"><span class="dm-group__description">{{ item.description }}</span></template>
        <template #[`item.grants`]="{ item }">
          <span v-if="item.grants.length" class="dm-grants">
            <v-chip v-for="(grant, i) in item.grants" :key="i" data-test="grant" size="small" label variant="tonal" color="primary">{{ grantText(grant) }}</v-chip>
          </span>
          <span v-else class="text-body-small text-medium-emphasis">no grants</span>
        </template>
        <template #[`item.members`]="{ item }">
          <span v-if="memberCount(item) === null" class="text-medium-emphasis">—</span>
          <router-link v-else-if="memberCount(item)" :to="{ path: '/users', query: { group: item.name } }" class="dm-num dm-members" :title="members(item.name).join(', ')"
            :aria-label="`${memberCount(item)} members of ${item.name}: show them in Users`" @click.stop>{{ memberCount(item) }}</router-link>
          <span v-else class="dm-num text-medium-emphasis">0</span>
        </template>
        <template #[`item.updatedAt`]="{ item }">
          <div v-if="item.updatedAt" class="dm-changed" :title="exactTime(item.updatedAt)">
            <span class="dm-num nowrap">{{ relative(item.updatedAt, now) }}</span>
            <span v-if="item.updatedBy" class="dm-changed__by text-medium-emphasis">by {{ item.updatedBy }}</span>
          </div>
        </template>
      </DmTable>
    </v-card>

    <v-dialog v-model="open" max-width="640" scrollable>
      <v-card v-if="editing" :title="editing.isNew ? 'New group' : `Group ${editing.name}`" :prepend-icon="mdiAccountGroupOutline" class="dm-dialog">
        <v-card-text>
          <v-text-field v-model="editing.name" label="Name" :disabled="!editing.isNew" autocomplete="off" :autofocus="editing.isNew"
            hint="Lower-case letters, digits and hyphens, up to 48; dmt- is reserved for the built-in roles." persistent-hint class="mb-3" />
          <v-text-field v-model="editing.description" label="Description" :counter="DESCRIPTION_MAX" class="mb-3" />
          <div class="dm-eyebrow mb-2">Grants (at most {{ GRANTS_MAX }})</div>
          <p class="text-body-small text-medium-emphasis mb-3">A workload is seen when a grant of one of the user's groups has all its tags on it; wake and nap include read. Tags are set on the workloads, not in AWS or Google Cloud.</p>
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
  </div>
</template>

<style scoped>
.dm-lead { max-width: 68rem; font-size: 0.98rem; line-height: 1.55; text-wrap: pretty; }
.dm-calm { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 14px; padding: 16px; text-align: start; }
/* A row opens its group: the hand says so. */
.dm-groups :deep(tbody tr:not(.v-data-table-rows-no-data):not(.v-data-table-rows-loading)) { cursor: pointer; }
.dm-group { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 6px 0; }
.dm-group__icon { flex: none; }
.dm-group__name { font-weight: 500; white-space: nowrap; }
.dm-group__description { display: inline-block; min-width: 10rem; text-wrap: pretty; }
.dm-grants { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 6px 0; }
.dm-changed { display: flex; flex-direction: column; line-height: 1.3; }
.dm-changed__by { font-size: 0.8rem; }
.dm-num { font-variant-numeric: tabular-nums; }
/* The members' count: a link to them in Users, as the router page's links. */
.dm-members { color: rgb(var(--v-theme-primary)); font-weight: 600; text-decoration: none; }
.dm-members:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-members:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-dialog :deep(.v-card-title) { white-space: normal; line-height: 1.3; }
</style>
