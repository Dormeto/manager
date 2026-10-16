<script setup lang="ts">
// Discovery perimeter (administrators): mode, regions, refresh period, global excludes and filters, with the lint of
// useless inclusions next to the criterion it concerns. The API validates and lists every error.
import { computed, onMounted, ref } from 'vue';
import { mdiArrowLeft, mdiCancel, mdiDeleteOutline, mdiEarth, mdiFilterOutline, mdiLightningBoltOutline, mdiMinusCircleOutline, mdiPlus, mdiPlusCircleOutline } from '@mdi/js';
import type { Criterion, DiscoveryConfig, LintFinding } from '@dormeto/discovery/types';
import { api, ApiError } from '../api';
import CriteriaEditor from '../components/CriteriaEditor.vue';
import LintAlert from '../components/LintAlert.vue';
import DmLoader from '../components/DmLoader.vue';
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
  <!-- A form: a centred column on a wide screen rather than fields stretched over it. -->
  <div class="dm-narrow">
    <div class="d-flex flex-wrap align-end ga-4 mb-6">
      <div>
        <div class="d-flex align-center mb-1">
          <v-btn :icon="mdiArrowLeft" variant="text" size="x-small" class="dm-back" to="/discovery" aria-label="Back to discovery" />
          <span class="dm-eyebrow">Organization</span>
        </div>
        <h1 class="text-headline-small">Discovery perimeter</h1>
      </div>
      <v-spacer />
      <div class="d-none d-md-flex align-center ga-3">
        <span v-if="updated.at" class="text-body-small text-medium-emphasis">Saved {{ relative(updated.at, now) }}<template v-if="updated.by"> by {{ updated.by }}</template></span>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="!config" @click="save">Save</v-btn>
      </div>
    </div>
    <p class="dm-lede text-medium-emphasis mb-6">A rule is in the perimeter when one filter includes it and that filter's excludes do not match it.
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
      <!-- The scope and the event-driven refresh side by side, 16 px apart, of one height: their switch boxes at the bottom. -->
      <div class="dm-pair mb-4">
        <v-card class="dm-pair__card">
          <v-card-item class="dm-head">
            <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiEarth" size="20" /></v-avatar></template>
            <v-card-title>Scope</v-card-title>
          </v-card-item>
          <v-card-text class="dm-body">
            <v-row class="dm-scope">
              <v-col cols="12">
                <v-select v-model="config.mode" :items="[{ title: 'Organization (every account)', value: 'organization' }, { title: 'This account only', value: 'account' }]" label="Mode" />
              </v-col>
              <v-col cols="12" class="pt-0">
                <v-text-field v-model.number="config.refreshHours" class="dm-hours" type="number" min="1" max="168" label="Refresh every (hours)" hint="1 to 168; the schedule ticks hourly" persistent-hint />
              </v-col>
              <v-col cols="12" class="pt-0">
                <div class="dm-field">
                  <v-switch v-model="allRegions" label="Every region enabled in each account" color="primary" hide-details inset density="compact" />
                  <v-expand-transition>
                    <div v-if="!allRegions" class="pt-3">
                      <v-text-field v-model="regionsText" label="Regions" hint="for example eu-west-1, eu-west-3" persistent-hint />
                    </div>
                  </v-expand-transition>
                </div>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
        <v-card class="dm-pair__card">
          <v-card-item class="dm-head">
            <template #prepend><v-avatar color="secondary" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiLightningBoltOutline" size="20" /></v-avatar></template>
            <v-card-title>Event-driven refresh</v-card-title>
            <v-card-subtitle class="text-wrap">Load balancer changes appear within about 5 minutes instead of at the next run</v-card-subtitle>
          </v-card-item>
          <v-card-text class="dm-body">
            <p class="text-body-medium text-medium-emphasis mb-4">The manager installs a forwarder in each ready account (a role, and a rule in each region a CloudTrail
              trail covers), through the command role; it removes them when turned off. Accounts without the command role or a trail stay on the
              refresh period, with the reason in the Organization access panel.</p>
            <div class="dm-field">
              <v-switch v-model="eventRefresh" label="Event-driven refresh" color="primary" hide-details inset density="compact" />
              <v-expand-transition>
                <div v-if="eventRefresh" class="pt-3">
                  <v-text-field v-model="refreshAccountsText" label="Only these accounts" hint="account ids; empty: every ready account" persistent-hint />
                </div>
              </v-expand-transition>
            </div>
          </v-card-text>
        </v-card>
      </div>

      <v-card class="mb-6">
        <v-card-item class="dm-head">
          <template #prepend><v-avatar color="error" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiCancel" size="20" /></v-avatar></template>
          <v-card-title>Global excludes</v-card-title>
          <v-card-subtitle class="text-wrap">A blacklist: never scanned when it names accounts, OUs or regions only; never included again by any filter</v-card-subtitle>
        </v-card-item>
        <v-card-text class="dm-body">
          <div v-for="(c, i) in config.globalExcludes" :key="`g${i}`" class="dm-crit">
            <span class="dm-crit__n">{{ i + 1 }}</span>
            <CriteriaEditor :model-value="c" class="dm-crit__editor" @update:model-value="(v: Criterion) => setAt(config!.globalExcludes, i, v)" />
            <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the global exclude" @click="removeAt(config!.globalExcludes, i)" />
          </div>
          <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" @click="config.globalExcludes.push({ accountIds: [] })">Global exclude</v-btn>
        </v-card-text>
      </v-card>

      <div class="d-flex flex-wrap align-end ga-3 mb-4">
        <div>
          <div class="dm-eyebrow mb-1">Perimeter</div>
          <h2 class="dm-h2">Filters</h2>
        </div>
      </div>
      <v-card v-for="(f, fi) in config.filters" :key="`f${fi}`" class="mb-4">
        <div class="dm-filter-head">
          <v-avatar color="primary" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiFilterOutline" size="20" /></v-avatar>
          <v-text-field v-model="f.name" label="Filter name" density="compact" hide-details class="dm-filter-head__name" />
          <v-spacer />
          <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the filter" @click="removeAt(config!.filters, fi)" />
        </div>
        <v-card-text class="dm-body">
          <div class="dm-section"><v-icon :icon="mdiPlusCircleOutline" color="success" size="18" />Include (any of)</div>
          <div v-for="(c, i) in f.include" :key="`i${i}`" class="mb-3">
            <div class="dm-crit mb-0">
              <span class="dm-crit__n">{{ i + 1 }}</span>
              <CriteriaEditor :model-value="c" class="dm-crit__editor" @update:model-value="(v: Criterion) => setAt(f.include, i, v)" />
              <v-btn :icon="mdiDeleteOutline" variant="text" size="small" :disabled="f.include.length === 1" aria-label="Remove the include" @click="removeAt(f.include, i)" />
            </div>
            <v-alert v-for="(l, li) in lintFor(lint, f.name, i + 1)" :key="li" :type="l.level === 'warning' ? 'warning' : 'info'" variant="tonal" density="compact" class="mt-2" :text="l.message" />
          </div>
          <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" class="mb-6" @click="f.include.push({})">Include</v-btn>
          <div class="dm-section"><v-icon :icon="mdiMinusCircleOutline" color="error" size="18" />Exclude (any of, this filter only)</div>
          <div v-for="(c, i) in f.exclude" :key="`e${i}`" class="dm-crit">
            <span class="dm-crit__n">{{ i + 1 }}</span>
            <CriteriaEditor :model-value="c" class="dm-crit__editor" @update:model-value="(v: Criterion) => setAt(f.exclude, i, v)" />
            <v-btn :icon="mdiDeleteOutline" variant="text" size="small" aria-label="Remove the exclude" @click="removeAt(f.exclude, i)" />
          </div>
          <v-btn :prepend-icon="mdiPlus" variant="tonal" size="small" @click="f.exclude.push({})">Exclude</v-btn>
        </v-card-text>
      </v-card>
      <v-btn :prepend-icon="mdiPlus" variant="tonal" class="mb-6" @click="addFilter">Filter</v-btn>
    </template>
    <v-card v-else-if="loading"><DmLoader label="Reading the perimeter…" /></v-card>

    <!-- On a phone, Save stays at hand: a glass bar held at the bottom of the screen. -->
    <div class="dm-savebar">
      <span class="dm-savebar__when text-body-small text-medium-emphasis"><template v-if="updated.at">Saved {{ relative(updated.at, now) }}<template v-if="updated.by"> by {{ updated.by }}</template></template></span>
      <v-btn color="primary" variant="flat" :loading="saving" :disabled="!config" class="dm-savebar__save" @click="save">Save</v-btn>
    </div>

    <v-snackbar v-model="saved" timeout="3000" color="success">Perimeter saved; the next run uses it.</v-snackbar>
  </div>
</template>

<style scoped>
.dm-narrow { max-width: 1120px; margin-inline: auto; }
.dm-lede { max-width: 82ch; }
.dm-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 1280px) { .dm-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.dm-pair__card { display: flex; flex-direction: column; }
.dm-pair__card > .dm-body { display: flex; flex: 1 1 auto; flex-direction: column; }
.dm-pair__card > .dm-body > .dm-field { margin-top: auto; }
.dm-scope { flex: 1 1 auto; align-content: space-between; }
.dm-hours { max-width: 16rem; }
.dm-back { margin: -6px 4px -6px -6px; }
/* A switch that is off stays visible on the glass. */
.dm-field :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) { background-color: rgba(var(--v-theme-on-surface), 0.2); opacity: 1; }
.dm-h2 { font-size: 1.35rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.03em; }
.dm-head { padding: 16px 16px 4px !important; }
.dm-body { padding: 16px !important; }
.dm-field { padding: 12px 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-section { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 0.92rem; font-weight: 600; letter-spacing: -0.01em; }
.dm-crit { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; align-items: start; margin-bottom: 12px; padding: 12px 8px 12px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-crit__n { display: grid; place-items: center; width: 26px; height: 26px; margin-top: 6px; border-radius: 50%; background: rgba(var(--v-theme-on-surface), 0.07);
  font: 500 0.72rem/1 var(--dm-mono); font-variant-numeric: tabular-nums; }
.dm-crit__editor { min-width: 0; }
.dm-filter-head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 4px; }
.dm-filter-head__name { flex: 0 1 360px; min-width: 0; }

/* Save on a phone (below Vuetify's md, where the header's Save shows): sticky at the bottom of the screen (the page's own
   transform rules out a fixed bar). */
.dm-savebar { display: none; }
@media (max-width: 839.98px) {
  .dm-savebar { position: sticky; z-index: 5; bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; padding: 10px 10px 10px 16px;
    border-radius: 18px; border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.6)); background: rgba(var(--v-theme-surface), 0.82);
    backdrop-filter: blur(16px) saturate(1.3); box-shadow: 0 18px 40px -20px rgba(var(--v-theme-on-surface), 0.35); }
  .dm-savebar__when { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dm-savebar__save { flex: none; min-width: 112px; }
}
@media (max-width: 600px) {
  .dm-head { padding: 16px 16px 4px !important; }
  .dm-body { padding: 14px 16px 18px !important; }
  .dm-filter-head { padding: 16px 12px 4px 16px; }
  .dm-crit { grid-template-columns: minmax(0, 1fr) auto; padding: 10px; }
  .dm-crit__n { display: none; }
}
</style>
