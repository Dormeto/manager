<script setup lang="ts">
// The organization's workload types (settings at scale design §5, §9): the custom ones (picked by a workload's tags, in
// order, or set on it) then the built-in ones (from its backends), each with its defaults and, for administrators, how many
// workloads it has. Administrators add, change, order and remove custom types and set any type's defaults; the whole list
// is written at once.
import { computed, ref } from 'vue';
import { mdiArrowUp, mdiDeleteOutline, mdiPencilOutline, mdiPlus, mdiShapeOutline, mdiTuneVariant } from '@mdi/js';
import { api } from '../api';
import { BUILT_IN_TYPES, TYPE_LABELS, defaultsLines, type Defaults } from '../defaults';
import { useSession } from '../stores/session';
import DefaultsDialog from './DefaultsDialog.vue';
import InfoTip from './InfoTip.vue';
import type { Notice } from './NoticeAlert.vue';

interface TypeEntry { name: string; description?: string; tags?: Record<string, string>; settings?: Defaults }
const emit = defineEmits<{ notice: [Notice] }>();
const session = useSession();
const types = ref<TypeEntry[]>([]);
const builtIn = ref<string[]>(BUILT_IN_TYPES);
const counts = ref<Record<string, number>>({});
const error = ref('');
const loaded = ref(false);
const saving = ref(false);

const custom = computed(() => types.value.filter((t) => !builtIn.value.includes(t.name)));
const rows = computed(() => [
  ...custom.value.map((t) => ({ ...t, builtIn: false })),
  ...builtIn.value.map((name) => ({ name, builtIn: true, settings: types.value.find((t) => t.name === name)?.settings ?? {} } as TypeEntry & { builtIn: boolean })),
]);
const lineOf = (settings?: Defaults) => defaultsLines(settings).map((l) => `${l.label} ${l.value}`).join(' · ') || 'No defaults';
const tagsText = (tags?: Record<string, string>) => Object.entries(tags ?? {}).map(([k, v]) => `${k}=${v}`);

async function load() {
  try {
    const answer = await api<{ types?: TypeEntry[]; builtIn?: string[] }>('/settings/types');
    types.value = answer.types ?? [];
    builtIn.value = answer.builtIn ?? BUILT_IN_TYPES;
    loaded.value = true;
    if (session.isAdmin) void count();
  } catch (err) {
    error.value = (err as Error).message;
  }
}
async function count() {
  const names = rows.value.map((r) => r.name);
  const answers = await Promise.all(names.map((name) => api<{ workloads: number }>(`/settings/reach?level=type&name=${encodeURIComponent(name)}`).catch(() => null)));
  counts.value = Object.fromEntries(names.flatMap((name, i) => (typeof answers[i]?.workloads === 'number' ? [[name, answers[i]!.workloads]] : [])));
}
void load();

async function save(list: TypeEntry[], done: string) {
  saving.value = true;
  try {
    const answer = await api<{ types: TypeEntry[]; note: string }>('/settings/types', { method: 'PUT', body: JSON.stringify({ types: list }) });
    types.value = answer.types ?? list;
    emit('notice', { type: 'success', text: `${done}: ${answer.note}.` });
    return true;
  } catch (err) {
    emit('notice', { type: 'error', text: (err as Error).message });
    return false;
  } finally {
    saving.value = false;
  }
}

// A custom type: its name, what it is for, its tags (key=value, one a line).
const typeOpen = ref(false);
const editing = ref<string | null>(null);
const draft = ref({ name: '', description: '', tags: '' });
const typeProblem = ref('');
function openType(entry?: TypeEntry) {
  editing.value = entry?.name ?? null;
  draft.value = { name: entry?.name ?? '', description: entry?.description ?? '', tags: tagsText(entry?.tags).join('\n') };
  typeProblem.value = '';
  typeOpen.value = true;
}
async function saveType() {
  const name = draft.value.name.trim();
  const tags = Object.fromEntries(draft.value.tags.split(/[\n,]/).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const malformed = draft.value.tags.split(/[\n,]/).map((l) => l.trim()).filter(Boolean).some((l) => !l.includes('=') || !l.slice(0, l.indexOf('=')).trim());
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) typeProblem.value = 'A name is lower-case letters, digits and hyphens, starting with a letter (at most 32).';
  else if (builtIn.value.includes(name)) typeProblem.value = `${name} is a built-in type: set its defaults instead.`;
  else if (name !== editing.value && types.value.some((t) => t.name === name)) typeProblem.value = `A type named ${name} exists.`;
  else if (malformed || !Object.keys(tags).length) typeProblem.value = 'Tags: at least one key=value, one a line.';
  else typeProblem.value = '';
  if (typeProblem.value) return;
  const description = draft.value.description.trim();
  const entry: TypeEntry = { name, ...(description ? { description } : {}), tags, settings: types.value.find((t) => t.name === editing.value)?.settings ?? {} };
  const list = editing.value ? types.value.map((t) => (t.name === editing.value ? entry : t)) : [...types.value, entry];
  if (await save(list, editing.value ? `Type ${name} saved` : `Type ${name} added`)) typeOpen.value = false;
}

function move(name: string) {
  const list = [...types.value];
  const at = list.findIndex((t) => t.name === name);
  // Before the custom type above it: built-in entries keep no order.
  const above = list.slice(0, at).map((t, i) => [t, i] as const).filter(([t]) => !builtIn.value.includes(t.name)).at(-1)?.[1];
  if (above === undefined) return;
  list.splice(above, 0, ...list.splice(at, 1));
  void save(list, `Type ${name} moved up`);
}
const remove = (name: string) => save(types.value.filter((t) => t.name !== name), `Type ${name} removed`);

// A type's defaults, merged with what it holds (null removes a key); a built-in type left with none leaves the list.
const defaultsOpen = ref(false);
const defaultsOf = ref<string>('');
const valuesOf = (name: string) => types.value.find((t) => t.name === name)?.settings ?? {};
async function saveDefaults(changes: Record<string, unknown>) {
  const name = defaultsOf.value;
  const merged = Object.fromEntries(Object.entries({ ...valuesOf(name), ...changes }).filter(([, v]) => v !== null)) as Defaults;
  const known = types.value.some((t) => t.name === name);
  const list = known ? types.value.map((t) => (t.name === name ? { ...t, settings: merged } : t)) : [...types.value, { name, settings: merged }];
  const kept = list.filter((t) => !(builtIn.value.includes(t.name) && !Object.keys(t.settings ?? {}).length));
  if (await save(kept, `The defaults of ${name} are saved`)) defaultsOpen.value = false;
}
</script>

<template>
  <v-card data-test="workload-types">
    <v-card-item>
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiShapeOutline" size="19" /></v-avatar></template>
      <v-card-title class="d-flex align-center ga-2">Workload types
        <InfoTip label="What a workload type is" test="workload-types">A workload's type is its own (set on it), else the first custom type its tags select, else the built-in one its backends give. A type's defaults come after the workload's own values and before its router's.</InfoTip>
      </v-card-title>
      <template #append>
        <v-btn v-if="session.isAdmin && loaded" data-test="add-type" :prepend-icon="mdiPlus" variant="text" size="small" @click="openType()">Add</v-btn>
      </template>
    </v-card-item>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <v-card-text v-else-if="loaded" class="pt-0">
      <div v-for="row in rows" :key="row.name" data-test="type-row" :data-name="row.name" class="dm-type">
        <div class="d-flex flex-wrap align-center ga-2">
          <strong>{{ row.builtIn ? TYPE_LABELS[row.name] ?? row.name : row.name }}</strong>
          <span v-if="row.builtIn" class="dm-mono text-medium-emphasis">{{ row.name }}</span>
          <v-chip v-for="t in tagsText(row.tags)" :key="t" size="x-small" label variant="tonal">{{ t }}</v-chip>
          <span v-if="counts[row.name] !== undefined" class="text-body-small text-medium-emphasis">{{ counts[row.name] }} workload{{ counts[row.name] === 1 ? '' : 's' }}</span>
          <v-spacer />
          <template v-if="session.isAdmin">
            <v-btn data-test="edit-defaults" :icon="mdiTuneVariant" variant="text" size="x-small" :aria-label="`Defaults of ${row.name}`" @click="defaultsOf = row.name; defaultsOpen = true" />
            <template v-if="!row.builtIn">
              <v-btn data-test="edit-type" :icon="mdiPencilOutline" variant="text" size="x-small" :aria-label="`Change ${row.name}`" @click="openType(row)" />
              <v-btn data-test="move-up" :icon="mdiArrowUp" variant="text" size="x-small" :aria-label="`Move ${row.name} up`" :disabled="saving" @click="move(row.name)" />
              <v-btn data-test="remove-type" :icon="mdiDeleteOutline" variant="text" size="x-small" :aria-label="`Remove ${row.name}`" :disabled="saving" @click="remove(row.name)" />
            </template>
          </template>
        </div>
        <div class="text-body-small">{{ lineOf(row.settings) }}</div>
        <div v-if="row.description" class="text-body-small text-medium-emphasis">{{ row.description }}</div>
      </div>
    </v-card-text>
  </v-card>
  <v-dialog v-model="typeOpen" max-width="480">
    <v-card :title="editing ? `Type ${editing}` : 'New type'" data-test="type-dialog">
      <v-card-text class="pt-3">
        <v-text-field v-model="draft.name" data-test="type-name" label="Name" hint="Lower-case letters, digits and hyphens" persistent-hint density="compact" class="mb-2" />
        <v-text-field v-model="draft.description" data-test="type-description" label="What it is for (optional)" density="compact" class="mb-2" />
        <v-textarea v-model="draft.tags" data-test="type-tags" label="Tags that select it (key=value, one a line)" rows="2" auto-grow density="compact"
          hint="A workload with every one of these tags takes this type, unless one above selects it first." persistent-hint />
        <v-alert v-if="typeProblem" data-test="type-problem" type="error" variant="tonal" density="compact" class="mt-3" :text="typeProblem" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="typeOpen = false">Cancel</v-btn>
        <v-btn data-test="save-type" color="primary" variant="flat" :loading="saving" @click="saveType">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <DefaultsDialog v-model="defaultsOpen" :title="`Defaults of the type ${defaultsOf}`" level="type" :name="defaultsOf" :values="valuesOf(defaultsOf)" :saving="saving" @submit="saveDefaults" />
</template>

<style scoped>
.dm-type { padding: 10px 0; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-type:first-child { border-top: 0; }
.dm-mono { font-family: var(--dm-mono); font-size: 0.8rem; }
</style>
