<script setup lang="ts">
// Organization discovery: the last run (scanned, skipped and failed account-regions, lint) and the candidate rules.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiCancel, mdiCogOutline, mdiEyeOffOutline, mdiEyeOutline, mdiLogoutVariant, mdiPlay, mdiPlusCircleOutline } from '@mdi/js';
import type { Candidate, RunRecord, Status } from '@dormeto/discovery/types';
import { api } from '../api';
import ExcludeDialog from '../components/ExcludeDialog.vue';
import OnboardDialog from '../components/OnboardDialog.vue';
import type { RouterInfo, WorkloadSummary } from '../types';
import LintAlert from '../components/LintAlert.vue';
import { exclusionTargets, exclusionText } from '../pause';
import type { Exclusion } from '../types';
import { STATUSES, ruleLines, statusColor, statusLabel, targetText, workloadOf } from '../discovery';
import { relative } from '../format';
import BackendLabel from '../components/BackendLabel.vue';
import DiscoveryStatusChip from '../components/DiscoveryStatusChip.vue';
import IdleBar from '../components/IdleBar.vue';
import RegionLabel from '../components/RegionLabel.vue';
import StatusHelp from '../components/StatusHelp.vue';
import { useNow } from '../now';
import { useDiscoveryBadge } from '../stores/discovery';
import { useSession } from '../stores/session';

const now = useNow();
const session = useSession();
const badge = useDiscoveryBadge();
const { smAndDown } = useDisplay();
const lastRun = ref<RunRecord | null>(null);
const candidates = ref<Candidate[]>([]);
const loading = ref(false);
const running = ref(false);
const error = ref('');
const shown = ref<Status[]>(['pending-onboarding', 'pending-offboarding', 'managed', 'ineligible']);
const selected = ref<string[]>([]);
const dismissDialog = ref(false);
const note = ref('');
const exclusions = ref<Exclusion[]>([]);
const onboardOpen = ref(false);
const excludeOpen = ref(false);
const notice = ref<{ type: 'success' | 'error'; text: string } | null>(null);
let poll: number | undefined;
// Managed candidates link to their workload, by its name (the workload id is not for people).
const workloadFor = ref<ReturnType<typeof workloadOf>>(() => null);

async function loadWorkloads() {
  try {
    const [{ routers }, { workloads }] = await Promise.all([api<{ routers: RouterInfo[] }>('/routers'), api<{ workloads: WorkloadSummary[] }>('/workloads')]);
    workloadFor.value = workloadOf(routers, workloads);
  } catch {
    // Names are a convenience: the candidates show without them.
  }
}

async function load() {
  loading.value = true;
  try {
    const [result, excluded] = await Promise.all([
      api<{ lastRun: RunRecord | null; candidates: Candidate[] }>('/discovery'),
      api<{ exclusions: Exclusion[] }>('/exclusions'),
    ]);
    lastRun.value = result.lastRun;
    candidates.value = result.candidates;
    exclusions.value = excluded.exclusions.sort((a, b) => b.at.localeCompare(a.at));
    badge.fromCounts(result.lastRun?.counts);
    error.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

// The run is asynchronous: poll until a new run record appears (a run takes seconds to minutes).
async function runNow() {
  running.value = true;
  const before = lastRun.value?.startedAt;
  try {
    await api('/discovery/run', { method: 'POST' });
  } catch (err) {
    error.value = (err as Error).message;
    running.value = false;
    return;
  }
  const deadline = Date.now() + 15 * 60_000;
  poll = window.setInterval(async () => {
    await load();
    if (lastRun.value?.startedAt !== before || Date.now() > deadline) {
      window.clearInterval(poll);
      running.value = false;
    }
  }, 5000);
}

async function changeDismissal(action: 'dismiss' | 'restore') {
  try {
    await api(`/discovery/${action}`, { method: 'POST', body: JSON.stringify({ ids: selected.value, ...(action === 'dismiss' && note.value ? { note: note.value } : {}) }) });
    selected.value = [];
    note.value = '';
    dismissDialog.value = false;
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

// Manual exclusions: a target group, load balancer or account kept away from Dormeto (operators).
const excludeOptions = computed(() => {
  const c = selected.value.length === 1 ? candidates.value.find((x) => x.id === selected.value[0]) : undefined;
  return c ? exclusionTargets(c) : [];
});

async function exclude(body: object) {
  excludeOpen.value = false;
  try {
    const result = await api<{ candidates: number; paused: { router: string; workloadId: string }[]; unpaused: string[] }>('/exclusions', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `Excluded: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} updated${result.paused.length ? `, paused ${result.paused.map((p) => p.workloadId).join(', ')}` : ''}${result.unpaused.length ? `; no registered router manages ${result.unpaused.join(', ')}` : ''}.` };
    selected.value = [];
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function lift(e: Exclusion) {
  try {
    const result = await api<{ candidates: number; resumed: { workloadId: string }[]; errors: string[] }>(`/exclusions/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
    notice.value = { type: result.errors.length ? 'error' : 'success', text: `Exclusion lifted: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} back${result.resumed.length ? `, resumed ${result.resumed.map((p) => p.workloadId).join(', ')}` : ''}${result.errors.length ? `; ${result.errors.join('; ')}` : ''}.` };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

// Onboarding and offboarding: operations run by the workflow (Operations view).
const single = computed(() => (selected.value.length === 1 ? candidates.value.find((x) => x.id === selected.value[0]) : undefined));
const onboardable = computed(() => single.value?.status === 'pending-onboarding');
const offboardable = computed(() => Boolean(single.value?.workloadId) && ['managed', 'pending-offboarding'].includes(single.value!.status));

async function startOperation(body: Record<string, unknown>, what: string) {
  try {
    const { operation } = await api<{ operation: { id: string } }>('/operations', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `${what} started (operation ${operation.id}): follow it in Operations.` };
    selected.value = [];
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function onboard(form: { name?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[] }) {
  onboardOpen.value = false;
  await startOperation({ type: 'onboard', candidateId: single.value!.id, ...form }, `Onboarding of ${form.name ?? single.value!.targetGroup ?? 'the candidate'}`);
}

async function offboard() {
  const c = single.value!;
  const routers = (await api<{ routers: RouterInfo[] }>('/routers')).routers;
  const router = routers.find((r) => r.account === c.account && r.region === c.region);
  if (!router) {
    notice.value = { type: 'error', text: `no router of the manager in ${c.account}/${c.region}` };
    return;
  }
  const name = workloadFor.value(c)?.name;
  await startOperation({ type: 'offboard', router: router.name, workloadId: c.workloadId, ...(name ? { name } : {}) }, `Offboarding of ${name ?? 'the workload'}`);
}

onMounted(() => { load(); loadWorkloads(); });
onBeforeUnmount(() => window.clearInterval(poll));

const order = (s: Status) => STATUSES.indexOf(s);
const counts = computed(() => Object.fromEntries(STATUSES.map((s) => [s, candidates.value.filter((c) => c.status === s).length])) as Record<Status, number>);
const visible = computed(() => candidates.value
  .filter((c) => shown.value.includes(c.status))
  .sort((a, b) => order(a.status) - order(b.status) || a.account.localeCompare(b.account) || a.region.localeCompare(b.region) || a.loadBalancer.localeCompare(b.loadBalancer)));
const failed = computed(() => lastRun.value?.targets.filter((t) => t.status === 'error') ?? []);
const scanned = computed(() => lastRun.value?.targets.filter((t) => t.status === 'ok').length ?? 0);
// Skipped pairs are summarized per reason (older records listed them as targets).
const skipped = computed(() => lastRun.value?.skipped?.reduce((n, s) => n + s.pairs, 0) ?? lastRun.value?.targets.filter((t) => t.status === 'skipped').length ?? 0);
const seconds = computed(() => (lastRun.value ? Math.round((Date.parse(lastRun.value.finishedAt) - Date.parse(lastRun.value.startedAt)) / 1000) : null));
const selectedDismissed = computed(() => selected.value.length > 0 && selected.value.every((id) => candidates.value.find((c) => c.id === id)?.status === 'dismissed'));
const runColor = (status: RunRecord['status']) => ({ ok: 'success', partial: 'warning', failed: 'error', skipped: 'grey' })[status];
const headers = [
  { title: 'Status', key: 'status' },
  { title: 'Account', key: 'account' },
  { title: 'Region', key: 'region' },
  { title: 'Rule', key: 'conditions', sortable: false },
  { title: 'Backend', key: 'backend', sortable: false },
  { title: 'Idle (7 days)', key: 'idleHours7d', align: 'end' as const },
  { title: 'Reason', key: 'statusReason', sortable: false },
  { title: 'First seen', key: 'firstSeenAt' },
];
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-2 mb-2">
    <h1 class="text-headline-small">Discovery</h1>
    <v-spacer />
    <v-btn v-if="session.isAdmin" :prepend-icon="mdiCogOutline" variant="text" to="/discovery/settings">Perimeter</v-btn>
    <v-btn v-if="session.canOperate" :prepend-icon="mdiPlay" variant="tonal" :loading="running" @click="runNow">Run now</v-btn>
  </div>
  <p class="text-medium-emphasis mb-4">Load balancer rules of every account and region of the perimeter, read with the read-only
    <code>DmtDiscoveryRole</code>. Discovery runs on a schedule and on demand; idle shares are the hours without any request over the last 7 days.</p>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-if="notice" :type="notice.type" closable class="mb-4" :text="notice.text" @click:close="notice = null" />

  <v-card class="mb-4" :loading="loading">
    <v-card-text v-if="!lastRun" class="text-medium-emphasis">No discovery run yet.</v-card-text>
    <v-card-text v-else>
      <div class="d-flex flex-wrap align-center ga-2">
        <v-chip :color="runColor(lastRun.status)" variant="tonal" label>{{ lastRun.status }}</v-chip>
        <span>Last run {{ relative(lastRun.startedAt, now) }} ({{ lastRun.trigger }}<template v-if="lastRun.by"> by {{ lastRun.by }}</template>)<template v-if="seconds !== null">, {{ seconds }} s</template>:
          {{ scanned }} account-region{{ scanned === 1 ? '' : 's' }} scanned, {{ skipped }} skipped, {{ failed.length }} failed.</span>
      </div>
      <v-alert v-if="lastRun.error" type="error" variant="tonal" density="compact" class="mt-3" :text="lastRun.error" />
      <p v-if="lastRun.skippedReason" class="text-medium-emphasis mt-2">Skipped: {{ lastRun.skippedReason }}.</p>
      <ul v-if="failed.length" class="mt-3 pl-4">
        <li v-for="t in failed" :key="`${t.account}/${t.region}`" class="text-body-medium text-error">{{ targetText(t) }}</li>
      </ul>
    </v-card-text>
  </v-card>

  <LintAlert v-if="lastRun" :findings="lastRun.lint" :settings-link="session.isAdmin" />

  <div class="d-flex flex-wrap align-center ga-2 mb-2">
    <v-chip-group v-model="shown" multiple column>
      <v-tooltip v-for="s in STATUSES" :key="s" location="top" max-width="380">
        <template #activator="{ props }">
          <v-chip v-bind="props" :value="s" :color="statusColor(s)" filter variant="tonal">{{ statusLabel(s) }} ({{ counts[s] }})</v-chip>
        </template>
        <StatusHelp :status="s" />
      </v-tooltip>
    </v-chip-group>
    <v-spacer />
    <template v-if="session.canOperate && selected.length">
      <v-btn v-if="onboardable" :prepend-icon="mdiPlusCircleOutline" color="primary" variant="tonal" @click="onboardOpen = true">Onboard…</v-btn>
      <v-btn v-if="offboardable" :prepend-icon="mdiLogoutVariant" variant="tonal" @click="offboard">Offboard</v-btn>
      <v-btn v-if="excludeOptions.length" :prepend-icon="mdiCancel" variant="tonal" @click="excludeOpen = true">Exclude…</v-btn>
      <v-btn v-if="selectedDismissed" :prepend-icon="mdiEyeOutline" variant="tonal" @click="changeDismissal('restore')">Restore ({{ selected.length }})</v-btn>
      <v-btn v-else :prepend-icon="mdiEyeOffOutline" variant="tonal" @click="dismissDialog = true">Dismiss ({{ selected.length }})</v-btn>
    </template>
  </div>

  <v-card>
    <v-data-table v-model="selected" :mobile="smAndDown" :headers="headers" :items="visible" :loading="loading" item-value="id"
      :show-select="session.canOperate" :items-per-page="50">
      <template #[`item.status`]="{ item }"><DiscoveryStatusChip :status="item.status" /></template>
      <template #[`item.account`]="{ item }">
        <div>{{ item.accountName }}</div>
        <div class="text-body-small text-medium-emphasis mono">{{ item.account }}</div>
      </template>
      <template #[`item.region`]="{ item }"><RegionLabel :region="item.region" /></template>
      <template #[`item.conditions`]="{ item }">
        <div class="font-weight-medium">{{ item.conditions }}</div>
        <div class="text-body-small text-medium-emphasis">{{ item.loadBalancer }} · {{ item.listener }} · priority {{ item.priority }}
          <v-tooltip v-if="item.rules?.length > 1" location="top" max-width="520">
            <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="tonal" class="ml-1" tabindex="0">{{ item.rules.length }} rules</v-chip></template>
            <div v-for="line in ruleLines(item.rules)" :key="line">{{ line }}</div>
          </v-tooltip>
        </div>
      </template>
      <template #[`item.backend`]="{ item }">
        <BackendLabel v-if="item.backend" :backend="item.backend" :account="item.account" :region="item.region" />
        <span v-else-if="item.workloadId" class="text-medium-emphasis">workload {{ workloadFor(item)?.name ?? '' }}</span>
      </template>
      <template #[`item.idleHours7d`]="{ item }">
        <IdleBar v-if="item.idleHours7d !== null" :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d" />
      </template>
      <template #[`item.statusReason`]="{ item }">
        <span v-if="item.status === 'managed' && workloadFor(item)" class="text-medium-emphasis">managed as
          <router-link :to="`/workloads/${workloadFor(item)!.router}/${workloadFor(item)!.workloadId}`">{{ workloadFor(item)!.name }}</router-link></span>
        <span v-else class="text-medium-emphasis">{{ item.statusReason }}</span>
      </template>
      <template #[`item.firstSeenAt`]="{ item }"><span class="nowrap">{{ relative(item.firstSeenAt, now) }}</span></template>
    </v-data-table>
  </v-card>

  <v-card id="exclusions" class="mt-4" title="Exclusions">
    <v-card-subtitle class="text-wrap">Target groups, load balancers and accounts kept away from Dormeto: discovery never proposes them, whatever
      the perimeter includes, and the managed workloads they match stay awake until offboarded.</v-card-subtitle>
    <v-list v-if="exclusions.length" lines="three">
      <v-list-item v-for="e in exclusions" :key="e.id" :title="exclusionText(e.target)">
        <v-list-item-subtitle class="text-wrap">
          {{ e.reason }} · by {{ e.by }} {{ relative(e.at, now) }} · {{ e.expiresAt ? (e.expired ? `expired ${relative(e.expiresAt, now)}` : `expires ${relative(e.expiresAt, now)}`) : 'no expiry' }}
          <template v-if="e.paused?.length"> · {{ e.lifting ? 'still to resume' : 'paused' }} {{ e.paused.map((p) => `${p.router}/${p.workloadId}`).join(', ') }}</template>
        </v-list-item-subtitle>
        <template #append>
          <v-chip v-if="e.expired" variant="tonal" label class="mr-2">expired</v-chip>
          <v-chip v-if="e.lifting" color="warning" variant="tonal" label class="mr-2">lift incomplete</v-chip>
          <v-btn v-if="session.canOperate" variant="tonal" size="small" @click="lift(e)">{{ e.lifting ? 'Retry lift' : 'Lift' }}</v-btn>
        </template>
      </v-list-item>
    </v-list>
    <v-card-text v-else class="text-medium-emphasis">No exclusion. Select a candidate and choose Exclude to keep it, its load balancer or its account away from Dormeto.</v-card-text>
  </v-card>

  <ExcludeDialog v-model="excludeOpen" :options="excludeOptions" @submit="exclude" />
  <OnboardDialog v-model="onboardOpen" :title="single?.conditions ?? ''" :default-name="single?.targetGroup ?? null" @submit="onboard" />

  <v-dialog v-model="dismissDialog" max-width="480">
    <v-card title="Dismiss candidates">
      <v-card-text>
        <p class="mb-3">The {{ selected.length }} selected rule{{ selected.length === 1 ? '' : 's' }} will stay dismissed, whatever later scans find, until restored.</p>
        <v-text-field v-model="note" label="Note (why)" maxlength="256" counter />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="dismissDialog = false">Cancel</v-btn>
        <v-btn color="primary" variant="tonal" @click="changeDismissal('dismiss')">Dismiss</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
