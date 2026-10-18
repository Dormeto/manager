<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { mdiAlertOutline, mdiCheckCircleOutline, mdiOpenInNew, mdiProgressClock } from '@mdi/js';
import { api } from '../api';
import { PROCEDURE_URL } from '../access';
import DmLoader from '../components/DmLoader.vue';
import NoticeAlert from '../components/NoticeAlert.vue';
import ReleaseNotes from '../components/ReleaseNotes.vue';
import { busy, codeParts, pollDelay, SILENT_MS, withoutOwnHeading, type NotInstalled, type Pending, type Section, type UpdateState } from '../update';

// Get started's "Updating the manager" (the CLI's ways) and "Upgrade" (the Terraform module's).
const UPDATING = 'https://dormeto.com/get-started.html#update';
const MODULE_UPGRADE = 'https://dormeto.com/get-started.html#upgrade';

const current = ref<UpdateState | NotInstalled | null>(null);
const error = ref('');
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
// The version the first load saw: another one later means the API was replaced, and the dashboard is the old one.
const firstVersion = ref<string | null>(null);
// The first failed poll of the current run of failures (the API is replaced during its own apply).
const failingSince = ref<number | null>(null);
const notAnswering = ref(false);
const target = ref<string | null>(null);
const sections = ref<Section[] | null>(null);
const changesLoading = ref(false);
const sending = ref(false);

const state = computed(() => (current.value && current.value.installedWithCli ? current.value : null));
const isBusy = computed(() => (state.value ? busy(state.value) : false));
const reloadOffer = computed(() => current.value !== null && firstVersion.value !== null && current.value.version !== firstVersion.value);
const build = computed(() => state.value?.build ?? null);
const finished = computed(() => (build.value?.by === 'dashboard' && build.value.action === 'apply' && build.value.status !== 'IN_PROGRESS' ? build.value : null));
const succeeded = computed(() => finished.value?.status === 'SUCCEEDED');
const failed = computed(() => (build.value && build.value.status !== 'IN_PROGRESS' && build.value.status !== 'SUCCEEDED' ? build.value : null));
const failedStep = computed(() => failed.value?.steps[failed.value.steps.length - 1] ?? null);
// What a failure left: an apply from this page may have changed the manager; a plan from this page changed nothing.
const failedBy = computed(() => (failed.value?.by === 'dashboard' && (failed.value.action === 'apply' || failed.value.action === 'plan') ? failed.value.action : null));
const plan = computed(() => state.value?.plan ?? null);
const changesNothing = computed(() => plan.value !== null && !plan.value.summary.add && !plan.value.summary.change && !plan.value.summary.destroy);
const items = computed(() => (state.value?.versions ?? []).map((v) => ({ ...v, value: v.version })));

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '');
const subtitle = (v: { published: string | null; router: string | null; staged?: boolean }) =>
  [v.staged ? 'local' : '', day(v.published), v.router ? `router ${v.router}` : ''].filter(Boolean).join(' · ');

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

// Overlapping reads (a poll, a refresh after a request): only the newest one counts.
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  try {
    const next = await api<UpdateState | NotInstalled>('/update');
    if (seq !== loadSeq) return;
    current.value = next;
    firstVersion.value ??= next.version;
    failingSince.value = null;
    notAnswering.value = false;
    error.value = '';
  } catch (err) {
    if (seq !== loadSeq) return;
    // Kept as last shown; said only once it lasts (the API is being replaced).
    if (current.value === null) error.value = (err as Error).message;
    else {
      failingSince.value ??= Date.now();
      notAnswering.value = Date.now() - failingSince.value >= SILENT_MS;
    }
  }
}

function schedule() {
  clearTimeout(timer);
  if (stopped) return;
  timer = setTimeout(() => void tick(), pollDelay(current.value));
}

async function tick() {
  if (!document.hidden) await load();
  schedule();
}

async function refresh() {
  await load();
  schedule();
}

async function loadChanges(version: string) {
  changesLoading.value = true;
  sections.value = null;
  try {
    const got = await api<Section[]>(`/update/changes?to=${encodeURIComponent(version)}`);
    if (target.value === version) sections.value = Array.isArray(got) ? got : [];
  } catch {
    if (target.value === version) sections.value = [];
  } finally {
    if (target.value === version) changesLoading.value = false;
  }
}

watch(target, (version) => {
  sections.value = null;
  if (version) void loadChanges(version);
  else changesLoading.value = false;
});

// A target no longer on offer (it was applied) is dropped.
watch(items, (list) => {
  if (target.value && !list.some((v) => v.value === target.value)) target.value = null;
});

async function send(path: string, body: object, label: string) {
  sending.value = true;
  try {
    await api<Pending>(path, { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: label };
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
  try {
    // After a refusal too (409 busy): the buttons follow the state, not what the page last knew.
    await refresh();
  } finally {
    sending.value = false;
  }
}

const prepare = () => send('/update/plan', { version: target.value }, `Preparing the update to ${target.value}.`);
const planMismatch = computed(() => plan.value !== null && target.value !== null && target.value !== plan.value.version);
const confirm = () => send('/update/apply', { planBuild: plan.value!.build }, `Applying the update to ${plan.value!.version}.`);
const reload = () => location.reload();

void refresh();
onBeforeUnmount(() => {
  stopped = true;
  clearTimeout(timer);
});
</script>

<template>
  <div class="dm-narrow">
    <div class="mb-6">
      <div class="dm-eyebrow mb-1">Administration</div>
      <h1 class="text-headline-small">Update</h1>
    </div>
    <NoticeAlert v-if="notice" :notice="notice" @close="notice = null" />
    <v-alert v-if="error" type="error" class="mb-4" :text="error" />
    <v-alert v-if="notAnswering" type="warning" class="mb-4" :icon="mdiAlertOutline">
      Still trying: the manager is not answering. It may be restarting after an update.
    </v-alert>
    <v-alert v-if="reloadOffer" type="success" class="mb-4" :icon="mdiCheckCircleOutline">
      <div class="d-flex flex-wrap align-center ga-3">
        <span>The manager now runs {{ current!.version }}.</span>
        <v-spacer />
        <v-btn variant="flat" color="primary" size="small" @click="reload">Reload</v-btn>
      </div>
    </v-alert>
    <DmLoader v-if="!current && !error" label="Reading the update state…" :size="48" />

    <v-card v-if="current" class="mb-4">
      <v-card-text>
        <div class="text-body-small text-medium-emphasis">Running</div>
        <div class="text-headline-small dm-version">{{ current.version }}</div>
        <div v-if="state?.applied" class="text-body-medium text-medium-emphasis">
          last applied {{ state.applied.version }}<template v-if="state.applied.at"> on {{ day(state.applied.at) }}</template>
        </div>
      </v-card-text>
    </v-card>

    <!-- The API answers so whenever the module's install input is unset: also for a CLI install made with --build-role
         or with a CLI older than 0.2.0. -->
    <v-card v-if="current && !current.installedWithCli">
      <v-card-text>
        <p class="text-title-medium mb-2">Updates from this page are not set up for this manager.</p>
        <p class="mb-3">It was installed without <code>dormeto install</code>, or with a CLI older than 0.2.0, or with <code>--build-role</code>.</p>
        <ul class="dm-ways">
          <li>
            Installed with the CLI: run <code>dormeto install</code> again with the CLI 0.2.0 or later (without <code>--build-role</code>) to set up updates
            from this page, or <code>dormeto install --version &lt;version&gt;</code> from a laptop.
            <a :href="UPDATING" rel="noopener" target="_blank">Updating the manager<v-icon :icon="mdiOpenInNew" size="14" /></a>
          </li>
          <li>
            Installed with the Terraform module: raise the module's version in the configuration that installed it, and apply.
            <a :href="MODULE_UPGRADE" rel="noopener" target="_blank">Upgrade<v-icon :icon="mdiOpenInNew" size="14" /></a>
          </li>
        </ul>
      </v-card-text>
    </v-card>

    <template v-if="state">
      <v-alert v-if="state.pending?.notStarted" type="warning" class="mb-4" :icon="mdiAlertOutline">
        The update did not start. {{ state.pending.action === 'apply' ? 'Confirm again.' : 'Prepare the update again.' }}
      </v-alert>
      <v-alert v-if="succeeded && !reloadOffer" type="success" class="mb-4" :icon="mdiCheckCircleOutline">The manager now runs {{ finished!.version }}.</v-alert>

      <v-card v-if="build || (state.pending && !state.pending.notStarted)" class="mb-4" title="Progress">
        <v-card-text>
          <template v-if="build">
            <div class="d-flex flex-wrap align-center ga-2 mb-2">
              <v-chip label size="small" variant="tonal" :color="build.status === 'IN_PROGRESS' ? 'primary' : build.status === 'SUCCEEDED' ? 'success' : 'error'">{{ build.status }}</v-chip>
              <v-chip v-if="build.phase" label size="small" variant="tonal">{{ build.phase }}</v-chip>
              <span v-if="build.by === 'cli'" class="text-body-medium text-medium-emphasis">started from the CLI</span>
              <span v-else-if="build.action" class="text-body-medium text-medium-emphasis">{{ build.action }}{{ build.version ? ` ${build.version}` : '' }}</span>
            </div>
            <ol v-if="build.steps.length" class="dm-steps">
              <li v-for="(step, i) in build.steps" :key="i" :class="{ 'dm-steps--failed': failed && i === build.steps.length - 1 }">{{ step }}</li>
            </ol>
          </template>
          <div v-else class="d-flex align-center ga-2"><v-icon :icon="mdiProgressClock" size="18" />The request is waiting for its build.</div>
          <template v-if="failed">
            <p v-if="failedBy === 'plan'" class="mt-3 mb-2">The plan was not prepared<template v-if="failedStep">: <strong>{{ failedStep }}</strong></template>.</p>
            <p v-else-if="failedStep" class="mt-3 mb-2">The step that failed: <strong>{{ failedStep }}</strong></p>
            <pre v-if="failed.tail.length" class="dm-tail">{{ failed.tail.join('\n') }}</pre>
            <p v-if="failedBy === 'apply'" class="mt-3 mb-0">
              The manager is as the failure left it: prepare the update again, or run <code>dormeto install</code> from a laptop.
            </p>
          </template>
        </v-card-text>
      </v-card>

      <v-card class="mb-4" title="Target version">
        <v-card-text>
          <p v-if="state.releasesUnreachable" :class="items.length ? 'mb-3' : 'mb-0'">The releases could not be read: try again later.</p>
          <p v-else-if="!items.length" class="mb-0">Up to date</p>
          <v-select v-if="items.length" v-model="target" :items="items" item-title="version" item-value="value" label="Version" clearable hide-details="auto"
            :item-props="(v: (typeof items)[number]) => ({ disabled: !!v.disabled })">
            <template #item="{ item, props }">
              <v-list-item v-bind="props" :title="item.version">
                <template #subtitle>
                  {{ subtitle(item) }}
                  <template v-if="item.disabled">
                    <br /><template v-for="(p, i) in codeParts(item.disabled)" :key="i"><code v-if="p.code">{{ p.text }}</code><template v-else>{{ p.text }}</template></template>
                  </template>
                </template>
              </v-list-item>
            </template>
          </v-select>
        </v-card-text>
      </v-card>

      <template v-if="target">
        <DmLoader v-if="changesLoading" label="Reading the release notes…" :size="36" />
        <p v-if="sections && !sections.length" class="text-medium-emphasis">Release notes unavailable</p>
        <v-card v-for="s in sections ?? []" :key="s.version" class="mb-4" :title="s.version">
          <v-card-text>
            <v-alert v-if="s.accessNeeded" type="warning" variant="tonal" class="mb-3" :icon="mdiAlertOutline">
              {{ s.access }}
              <div class="mt-1">
                This update does not apply it.
                <a :href="PROCEDURE_URL" rel="noopener" target="_blank">Organization access</a>
              </div>
            </v-alert>
            <ReleaseNotes v-if="s.notes" :notes="withoutOwnHeading(s.notes, s.version)" />
            <p v-else class="text-medium-emphasis mb-0">Release notes unavailable</p>
          </v-card-text>
        </v-card>
      </template>

      <v-card v-if="plan" class="mb-4" :title="`Plan for ${plan.version}`">
        <v-card-text>
          <p v-if="changesNothing" class="mb-0">This plan changes nothing.</p>
          <template v-else>
            <div class="d-flex flex-wrap ga-4 mb-2 dm-counts">
              <span><strong>{{ plan.summary.add }}</strong> to add</span>
              <span><strong>{{ plan.summary.change }}</strong> to change</span>
              <span><strong>{{ plan.summary.destroy }}</strong> to destroy</span>
            </div>
            <template v-if="plan.summary.replaced.length">
              <div class="text-body-small text-medium-emphasis">Replaced</div>
              <ul class="dm-addresses"><li v-for="a in plan.summary.replaced" :key="a">{{ a }}</li></ul>
            </template>
            <template v-if="plan.summary.destroyed.length">
              <div class="text-body-small text-medium-emphasis">Destroyed</div>
              <ul class="dm-addresses"><li v-for="a in plan.summary.destroyed" :key="a">{{ a }}</li></ul>
            </template>
          </template>
        </v-card-text>
      </v-card>

      <p v-if="plan && planMismatch" class="text-body-medium mb-3">
        The plan was prepared for {{ plan.version }}: prepare {{ target }} to update to it, or pick {{ plan.version }} again.
      </p>
      <div class="d-flex ga-2">
        <v-btn variant="tonal" color="primary" :disabled="!target || isBusy || sending" @click="prepare">Prepare</v-btn>
        <v-btn variant="flat" color="primary" :disabled="!plan || planMismatch || isBusy || sending" @click="confirm">Confirm{{ plan ? ` ${plan.version}` : '' }}</v-btn>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dm-narrow { max-width: 860px; margin-inline: auto; }
.dm-version { font-variant-numeric: tabular-nums; }
.dm-ways { padding-left: 20px; }
.dm-ways li { margin-bottom: 8px; }
.dm-steps { padding-left: 22px; }
.dm-steps--failed { color: rgb(var(--v-theme-error)); font-weight: 600; }
.dm-tail { max-height: 320px; overflow: auto; padding: 12px; border-radius: 8px; background: rgba(var(--v-theme-on-surface), 0.06); font: 0.78rem/1.45 var(--dm-mono); white-space: pre-wrap; }
.dm-counts { font-variant-numeric: tabular-nums; }
.dm-addresses { padding-left: 20px; margin-bottom: 8px; font: 0.82rem/1.5 var(--dm-mono); }
code { padding: 1px 5px; border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.08); font-family: var(--dm-mono); font-size: 0.9em; }
</style>
