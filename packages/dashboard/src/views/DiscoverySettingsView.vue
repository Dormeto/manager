<script setup lang="ts">
// Discovery perimeter (administrators): mode, regions, refresh period, global excludes and filters, with the lint of
// useless inclusions next to the criterion it concerns. The API validates and lists every error.
import { computed, onMounted, ref } from 'vue';
import { mdiArrowLeft, mdiDeleteOutline, mdiPlus } from '@mdi/js';
import type { Criterion, DiscoveryConfig, LintFinding } from '@dormeto/discovery/types';
import { api, ApiError } from '../api';
import CriteriaEditor from '../components/CriteriaEditor.vue';
import LintAlert from '../components/LintAlert.vue';
import { formatList, lintFor, parseList } from '../discovery';
import { relative } from '../format';
import { useNow } from '../now';
import { procedureLink, type AccessReport } from '../access';

type Answer = { config: DiscoveryConfig; lint: LintFinding[]; updatedAt?: string | null; updatedBy?: string | null };

const now = useNow();
const config = ref<DiscoveryConfig | null>(null);
const lint = ref<LintFinding[]>([]);
const updated = ref<{ at: string | null; by: string | null }>({ at: null, by: null });
const errors = ref<string[]>([]);
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const regionsText = ref('');

// Event-driven refresh (packaging design §5): off unless enabled; accounts, empty for every ready account.
const eventRefresh = computed({
  get: () => config.value?.eventRefresh?.enabled ?? false,
  set: (enabled: boolean) => {
    if (!config.value) return;
    config.value.eventRefresh = { ...(config.value.eventRefresh ?? {}), enabled };
  },
});
const refreshAccountsText = ref('');

const allRegions = computed({
  get: () => config.value?.regions.includes('*') ?? false,
  set: (all: boolean) => {
    if (!config.value) return;
    config.value.regions = all ? ['*'] : parseList(regionsText.value);
  },
});

function apply(answer: Answer) {
  config.value = structuredClone(answer.config);
  lint.value = answer.lint;
  regionsText.value = answer.config.regions.includes('*') ? '' : formatList(answer.config.regions);
  refreshAccountsText.value = formatList(answer.config.eventRefresh?.accounts ?? []);
  if (answer.updatedAt !== undefined) updated.value = { at: answer.updatedAt ?? null, by: answer.updatedBy ?? null };
}

// The last run found no delegation policy: organization mode is unavailable (packaging design §3).
const delegationMissing = ref(false);

async function load() {
  loading.value = true;
  try {
    const [answer, access] = await Promise.all([api<Answer>('/discovery/config'), api<AccessReport>('/discovery/access?limit=1').catch(() => null)]);
    delegationMissing.value = access?.delegation === 'missing';
    apply(answer);
  } catch (err) {
    errors.value = [(err as Error).message];
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!config.value) return;
  if (!allRegions.value) config.value.regions = parseList(regionsText.value);
  if (config.value.eventRefresh) {
    const accounts = parseList(refreshAccountsText.value);
    config.value.eventRefresh = { enabled: config.value.eventRefresh.enabled, ...(accounts.length ? { accounts } : {}) };
  }
  saving.value = true;
  errors.value = [];
  try {
    apply(await api<Answer>('/discovery/config', { method: 'PUT', body: JSON.stringify(config.value) }));
    updated.value = { at: new Date().toISOString(), by: 'you' };
    saved.value = true;
  } catch (err) {
    const body = err instanceof ApiError ? (err.body as { errors?: string[] } | null) : null;
    errors.value = body?.errors ?? [(err as Error).message];
  } finally {
    saving.value = false;
  }
}

const addFilter = () => config.value!.filters.push({ name: `filter ${config.value!.filters.length + 1}`, include: [{}], exclude: [] });
const removeAt = <T,>(list: T[], index: number) => list.splice(index, 1);
const setAt = (list: Criterion[], index: number, value: Criterion) => { list[index] = value; };
const globalLint = computed(() => lint.value.filter((f) => f.code !== 'include-matches-nothing'));

onMounted(load);
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-2 mb-2">
    <v-btn :icon="mdiArrowLeft" variant="text" to="/discovery" aria-label="Back to discovery" />
    <h1 class="text-headline-small">Discovery perimeter</h1>
    <v-spacer />
    <span v-if="updated.at" class="text-body-small text-medium-emphasis">Saved {{ relative(updated.at, now) }}<template v-if="updated.by"> by {{ updated.by }}</template></span>
    <v-btn color="primary" variant="flat" :loading="saving" :disabled="!config" @click="save">Save</v-btn>
  </div>
  <p class="text-medium-emphasis mb-4">A rule is in the perimeter when one filter includes it and that filter's excludes do not match it.
    Global excludes come first: nothing includes them again, and Dormeto never reads a globally excluded account or region.
    Without any filter, nothing is scanned.</p>

  <v-alert v-if="delegationMissing && config?.mode === 'organization'" type="warning" variant="tonal" class="mb-4"
    title="Organization mode is unavailable">
    The last run could not list the organization's accounts: the delegation policy of the management account is missing.
    <a :href="procedureLink()" target="_blank" rel="noopener">How to set it up</a>, then Run now.
  </v-alert>
  <v-alert v-if="errors.length" type="error" variant="tonal" class="mb-4">
    <div class="font-weight-medium mb-1">The perimeter was not saved</div>
    <ul class="pl-4"><li v-for="e in errors" :key="e" class="mono text-body-small">{{ e }}</li></ul>
  </v-alert>
  <LintAlert :findings="globalLint" />

  <template v-if="config">
    <v-card class="mb-4" title="Scope">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="4">
            <v-select v-model="config.mode" :items="[{ title: 'Organization (every account)', value: 'organization' }, { title: 'This account only', value: 'account' }]" label="Mode" />
          </v-col>
          <v-col cols="12" md="5">
            <v-switch v-model="allRegions" label="Every region enabled in each account" color="primary" hide-details class="mb-2" />
            <v-text-field v-if="!allRegions" v-model="regionsText" label="Regions" hint="for example eu-west-1, eu-west-3" persistent-hint />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model.number="config.refreshHours" type="number" min="1" max="168" label="Refresh every (hours)" hint="1 to 168; the schedule ticks hourly" persistent-hint />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card class="mb-4" title="Event-driven refresh"
      subtitle="Load balancer changes appear within about 5 minutes instead of at the next run">
      <v-card-text>
        <p class="text-body-medium mb-2">The manager installs a forwarder in each ready account (a role, and a rule in each region a CloudTrail
          trail covers), through the command role; it removes them when turned off. Accounts without the command role or a trail stay on the
          refresh period, with the reason in the Organization access panel.</p>
        <v-row>
          <v-col cols="12" md="4">
            <v-switch v-model="eventRefresh" label="Event-driven refresh" color="primary" hide-details />
          </v-col>
          <v-col cols="12" md="8">
            <v-text-field v-if="eventRefresh" v-model="refreshAccountsText" label="Only these accounts" hint="account ids; empty: every ready account" persistent-hint />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card class="mb-4" title="Global excludes" subtitle="A blacklist: never scanned when it names accounts, OUs or regions only; never included again by any filter">
      <v-card-text>
        <div v-for="(c, i) in config.globalExcludes" :key="`g${i}`" class="d-flex align-start ga-2 mb-3">
          <span class="text-body-small text-medium-emphasis mt-2">{{ i + 1 }}</span>
          <CriteriaEditor :model-value="c" class="flex-grow-1" @update:model-value="(v: Criterion) => setAt(config!.globalExcludes, i, v)" />
          <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the global exclude" @click="removeAt(config!.globalExcludes, i)" />
        </div>
        <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" @click="config.globalExcludes.push({ accountIds: [] })">Global exclude</v-btn>
      </v-card-text>
    </v-card>

    <v-card v-for="(f, fi) in config.filters" :key="`f${fi}`" class="mb-4">
      <v-card-title class="d-flex align-center ga-2">
        <v-text-field v-model="f.name" label="Filter name" density="compact" hide-details style="max-width: 360px" />
        <v-spacer />
        <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the filter" @click="removeAt(config!.filters, fi)" />
      </v-card-title>
      <v-card-text>
        <div class="text-title-small mb-2">Include (any of)</div>
        <div v-for="(c, i) in f.include" :key="`i${i}`" class="mb-3">
          <div class="d-flex align-start ga-2">
            <span class="text-body-small text-medium-emphasis mt-2">{{ i + 1 }}</span>
            <CriteriaEditor :model-value="c" class="flex-grow-1" @update:model-value="(v: Criterion) => setAt(f.include, i, v)" />
            <v-btn :icon="mdiDeleteOutline" variant="text" size="small" :disabled="f.include.length === 1" aria-label="Remove the include" @click="removeAt(f.include, i)" />
          </div>
          <v-alert v-for="(l, li) in lintFor(lint, f.name, i + 1)" :key="li" :type="l.level === 'warning' ? 'warning' : 'info'" variant="tonal" density="compact" class="mt-1 ml-6" :text="l.message" />
        </div>
        <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" class="mb-4" @click="f.include.push({})">Include</v-btn>
        <div class="text-title-small mb-2">Exclude (any of, this filter only)</div>
        <div v-for="(c, i) in f.exclude" :key="`e${i}`" class="d-flex align-start ga-2 mb-3">
          <span class="text-body-small text-medium-emphasis mt-2">{{ i + 1 }}</span>
          <CriteriaEditor :model-value="c" class="flex-grow-1" @update:model-value="(v: Criterion) => setAt(f.exclude, i, v)" />
          <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the exclude" @click="removeAt(f.exclude, i)" />
        </div>
        <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" @click="f.exclude.push({})">Exclude</v-btn>
      </v-card-text>
    </v-card>
    <v-btn :prepend-icon="mdiPlus" variant="tonal" class="mb-6" @click="addFilter">Filter</v-btn>
  </template>
  <v-progress-linear v-else-if="loading" indeterminate />

  <v-snackbar v-model="saved" timeout="3000" color="success">Perimeter saved; the next run uses it.</v-snackbar>
</template>
