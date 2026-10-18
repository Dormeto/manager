<script setup lang="ts">
// Organization discovery: the last run (scanned, skipped and failed account-regions, lint) and the candidates, a status
// at a time, paged on the server (scale design §5), starting with the statuses people act on.
import { computed, onBeforeUnmount, onMounted, ref, watch as watchValue } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiAlertCircleOutline, mdiCancel, mdiChevronLeft, mdiChevronRight, mdiCogOutline, mdiEarth, mdiEyeOffOutline, mdiEyeOutline, mdiLanConnect, mdiLogoutVariant,
  mdiOfficeBuildingOutline, mdiPlay, mdiPlusCircleOutline, mdiSkipNextCircleOutline, mdiTarget, mdiTimerOutline } from '@mdi/js';
import type { Candidate, RunRecord, Status } from '@dormeto/discovery/types';
import { api } from '../api';
import ExcludeDialog from '../components/ExcludeDialog.vue';
import OnboardDialog from '../components/OnboardDialog.vue';
import type { ClusterCheck, RouterInfo } from '../types';
import type { KubernetesCandidate } from '../kubernetes';
import LintAlert from '../components/LintAlert.vue';
import OrganizationAccess from '../components/OrganizationAccess.vue';
import { onboardRefusal, type AccessReport } from '../access';
import { exclusionTargets, exclusionText } from '../pause';
import type { Exclusion } from '../types';
import type { Notice } from '../components/NoticeAlert.vue';
import NoticeToast from '../components/NoticeToast.vue';
import { operationLabel, operationWatch } from '../operation-watch';
import { cursorPages, visibleStatuses, firstStatus, idleShare, latestOnly, ruleLines, statusColor, statusLabel, targetText } from '../discovery';
import { relative } from '../format';
import { useCountUp } from '../count-up';
import BackendLabel from '../components/BackendLabel.vue';
import DiscoveryStatusChip from '../components/DiscoveryStatusChip.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
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
// A managed candidate carries its workload's name and router (from its summary), and the onboarding or offboarding
// running on it.
type Listed = Candidate & { workload?: { router: string; workloadId: string; name: string }; operation?: { id: string; type: 'onboard' | 'offboard' } };
const PAGE = 50;
const lastRun = ref<RunRecord | null>(null);
// Organization access of the last run (packaging design §3), and the roles set in the manager's Terraform.
const access = ref<AccessReport | null>(null);
const roles = ref<{ discoveryRole: string; commandRole: string } | null>(null);
const counts = ref<Partial<Record<Status, number>>>({});
const candidates = ref<Listed[]>([]);
const loading = ref(false);
const running = ref(false);
const error = ref('');
const status = ref<Status | null>(null);
const account = ref('');
const region = ref('');
const page = ref(0);
const pages = cursorPages();
const hasNext = ref(false);
// Answers of earlier page requests (a filter typed on, a page turned meanwhile) are dropped.
const latest = latestOnly();
// A Run now refused since the last run (another run was in progress).
const refused = ref<RunRecord | null>(null);
const selected = ref<string[]>([]);
const dismissDialog = ref(false);
const note = ref('');
const exclusions = ref<Exclusion[]>([]);
const onboardOpen = ref(false);
// A Kubernetes candidate (R10.5): its owner and switch for the dialog, and its router's last check of its cluster.
const singleKubernetes = computed(() => {
  const backend = single.value?.backend as { kind?: string; kubernetes?: KubernetesCandidate } | null | undefined;
  return backend?.kind === 'k8s' ? backend.kubernetes ?? null : null;
});
const clusterAccess = ref<ClusterCheck | null>(null);
watchValue(onboardOpen, async (open) => {
  clusterAccess.value = null;
  const c = single.value;
  const kubernetes = singleKubernetes.value;
  if (!open || !c || !kubernetes) return;
  const routers = (await api<{ routers: RouterInfo[] }>('/routers').catch(() => ({ routers: [] as RouterInfo[] }))).routers;
  clusterAccess.value = routers.find((r) => r.account === c.account && r.region === c.region)?.clusters?.find((x) => x.name === kubernetes.cluster) ?? null;
});
const excludeOpen = ref(false);
const notice = ref<Notice | null>(null);
let poll: number | undefined;
// Onboardings and offboardings running on the candidates shown: the page is refreshed every 10 s while one runs, and a
// toast says how each one ended (the candidate then moves to its status).
const watch = operationWatch((n) => {
  notice.value = n;
  void load();
});
let following: number | undefined;
function follow() {
  if (following !== undefined || !watch.active) return;
  following = window.setInterval(() => {
    if (watch.active) return void loadPage({ keep: true });
    window.clearInterval(following);
    following = undefined;
  }, 10_000);
}
const subjectOf = (c: Listed) => c.workload?.name ?? c.targetGroup ?? c.id;
const filtered = computed(() => /^\d{12}$/.test(account.value));

// One page of the shown status, within the account (and region) when given; a refresh keeps what is selected.
async function loadPage({ keep = false } = {}) {
  if (!status.value) return;
  const query = new URLSearchParams({ status: status.value, limit: String(PAGE) });
  if (filtered.value) {
    query.set('account', account.value);
    if (/^[a-z]{2}(-[a-z]+)+-\d$/.test(region.value)) query.set('region', region.value);
  }
  const at = page.value;
  const cursor = pages.cursor(at);
  if (cursor) query.set('cursor', cursor);
  const answer = await latest(() => api<{ candidates: Listed[]; cursor: string | null }>(`/discovery/candidates?${query}`));
  if (!answer) return;
  pages.loaded(at, answer.value.cursor);
  hasNext.value = pages.hasNext(at);
  candidates.value = answer.value.candidates;
  selected.value = keep ? selected.value.filter((id) => candidates.value.some((c) => c.id === id)) : [];
  watch.refreshed(candidates.value.flatMap((c) => (c.operation ? [{ ...c.operation, subject: subjectOf(c) }] : [])));
  follow();
}

async function load() {
  loading.value = true;
  try {
    const [result, excluded, report] = await Promise.all([
      api<{ lastRun: RunRecord | null; refused?: RunRecord; counts: Partial<Record<Status, number>>; access?: { discoveryRole: string; commandRole: string } }>('/discovery'),
      api<{ exclusions: Exclusion[] }>('/exclusions'),
      api<AccessReport>('/discovery/access?limit=1000').catch(() => null),
    ]);
    access.value = report;
    roles.value = result.access ?? null;
    lastRun.value = result.lastRun;
    refused.value = result.refused ?? null;
    counts.value = result.counts;
    exclusions.value = excluded.exclusions.sort((a, b) => b.at.localeCompare(a.at));
    badge.fromCounts(result.counts);
    status.value ??= firstStatus(result.counts);
    await loadPage();
    error.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

// Another status or filter starts again from the first page.
function show(next: Status | null) {
  if (!next) return;
  status.value = next;
  restart();
}
function restart() {
  page.value = 0;
  pages.reset();
  load();
}
// A filter being typed: loaded once typing pauses.
let typing: number | undefined;
function restartSoon() {
  window.clearTimeout(typing);
  typing = window.setTimeout(restart, 400);
}
function turn(by: number) {
  page.value += by;
  load();
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
  const refusedBefore = refused.value?.startedAt;
  // Until a new run finished (it shows as running while its accounts are scanned), or this one was refused; a run lasts
  // 3 hours at most.
  const deadline = Date.now() + 3 * 3_600_000;
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    await load();
    const finished = lastRun.value?.startedAt !== before && lastRun.value?.status !== 'running';
    if (finished || refused.value?.startedAt !== refusedBefore || Date.now() > deadline) {
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
    const result = await api<{ candidates: number; operation: { id: string } }>('/exclusions', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `Excluded: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} updated; its managed workloads are being paused (operation ${result.operation.id}).`, operation: result.operation.id };
    selected.value = [];
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function lift(e: Exclusion) {
  try {
    const result = await api<{ candidates: number; operation: { id: string } }>(`/exclusions/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
    notice.value = { type: 'success', text: `Exclusion lifted: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} back; its workloads are being resumed (operation ${result.operation.id}).`, operation: result.operation.id };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

// Onboarding and offboarding: operations run by the workflow (Operations view).
const single = computed(() => (selected.value.length === 1 ? candidates.value.find((x) => x.id === selected.value[0]) : undefined));
const onboardable = computed(() => single.value?.status === 'pending-onboarding');
// Refused by the API where the last run found the account's command role missing, or the account set up for discovery
// only: said here, before trying.
const noCommand = computed(() => onboardRefusal(access.value, single.value?.account));
const offboardable = computed(() => Boolean(single.value?.workloadId) && ['managed', 'pending-offboarding'].includes(single.value!.status));

async function startOperation(body: { type: 'onboard' | 'offboard' } & Record<string, unknown>, c: Listed, subject: string) {
  try {
    const { operation } = await api<{ operation: { id: string } }>('/operations', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `${operationLabel(body.type, subject)} started (operation ${operation.id}).`, operation: operation.id };
    // Shown running at once (the next refresh confirms it).
    c.operation = { id: operation.id, type: body.type };
    watch.watch(operation.id, body.type, subject);
    follow();
    selected.value = [];
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function onboard(form: { name?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[] }) {
  onboardOpen.value = false;
  const c = single.value!;
  await startOperation({ type: 'onboard', candidateId: c.id, ...form }, c, form.name ?? subjectOf(c));
}

async function offboard() {
  const c = single.value!;
  const routers = (await api<{ routers: RouterInfo[] }>('/routers')).routers;
  const router = routers.find((r) => r.account === c.account && r.region === c.region);
  if (!router) {
    notice.value = { type: 'error', text: `no router of the manager in ${c.account}/${c.region}` };
    return;
  }
  await startOperation({ type: 'offboard', router: router.name, workloadId: c.workloadId }, c, subjectOf(c));
}

onMounted(load);
onBeforeUnmount(() => {
  window.clearInterval(poll);
  window.clearInterval(following);
  window.clearTimeout(typing);
});

const failed = computed(() => lastRun.value?.targets.filter((t) => t.status === 'error') ?? []);
// Account-regions scanned without any rule are counted, not listed (R4.5).
const scanned = computed(() => (lastRun.value?.targets.filter((t) => t.status === 'ok').length ?? 0) + (lastRun.value?.emptyPairs ?? 0));
// Skipped pairs are summarized per reason (older records listed them as targets).
const skipped = computed(() => lastRun.value?.skipped?.reduce((n, s) => n + s.pairs, 0) ?? lastRun.value?.targets.filter((t) => t.status === 'skipped').length ?? 0);
const seconds = computed(() => (lastRun.value ? Math.round((Date.parse(lastRun.value.finishedAt) - Date.parse(lastRun.value.startedAt)) / 1000) : null));
const selectedDismissed = computed(() => selected.value.length > 0 && selected.value.every((id) => candidates.value.find((c) => c.id === id)?.status === 'dismissed'));
const runColor = (status: RunRecord['status']) => ({ running: 'info', ok: 'success', partial: 'warning', failed: 'error', skipped: 'grey' })[status];
// In account, region and id order (the index's): no other sort on the server.
const headers = [
  { title: 'Status', key: 'status', sortable: false },
  { title: 'Rule', key: 'conditions', sortable: false },
  { title: 'Account', key: 'account', sortable: false },
  { title: 'Region', key: 'region', sortable: false },
  { title: 'Backend', key: 'backend', sortable: false },
  { title: 'Idle (7 days)', key: 'idleHours7d', align: 'end' as const, sortable: false },
  { title: 'Reason', key: 'statusReason', sortable: false },
  { title: 'First seen', key: 'firstSeenAt', sortable: false },
];
const first = computed(() => page.value * PAGE + (candidates.value.length ? 1 : 0));
const last = computed(() => page.value * PAGE + candidates.value.length);
// Presentation: the first answer not there yet (the status is set by it), the icon's mood while a run scans, the run's
// figures as tiles, and an icon per kind of exclusion.
const waiting = computed(() => loading.value && status.value === null);
const scanning = computed(() => running.value || lastRun.value?.status === 'running');
// The tiles' numbers count up when they arrive (the labels read the values themselves).
const secondsUp = useCountUp(() => seconds.value ?? 0);
const scannedUp = useCountUp(() => scanned.value);
const skippedUp = useCountUp(() => skipped.value);
const failedUp = useCountUp(() => failed.value.length);
const runTiles = computed(() => [
  { key: 'duration', icon: mdiTimerOutline, color: 'secondary', value: lastRun.value?.status === 'running' || seconds.value === null ? '—' : `${secondsUp.value} s`, label: 'duration' },
  { key: 'scanned', icon: mdiEarth, color: 'success', value: scannedUp.value, label: `account-region${scanned.value === 1 ? '' : 's'} scanned` },
  { key: 'skipped', icon: mdiSkipNextCircleOutline, color: 'info', value: skippedUp.value, label: 'skipped' },
  { key: 'failed', icon: mdiAlertCircleOutline, color: 'error', value: failedUp.value, label: 'failed' },
]);
const KIND_ICONS: Record<string, string> = { account: mdiOfficeBuildingOutline, 'load-balancer': mdiLanConnect, 'target-group': mdiTarget };
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-6">
    <div>
      <div class="dm-eyebrow mb-1">Organization</div>
      <h1 class="text-headline-small">Discovery</h1>
    </div>
    <v-spacer />
    <div class="d-flex flex-wrap align-center ga-2">
      <v-btn v-if="session.isAdmin" :prepend-icon="mdiCogOutline" variant="text" to="/discovery/settings">Perimeter</v-btn>
      <v-btn v-if="session.canOperate" :prepend-icon="mdiPlay" color="primary" variant="flat" :loading="running" :disabled="lastRun?.status === 'running'" @click="runNow">Run now</v-btn>
    </div>
  </div>
  <p class="dm-lede text-medium-emphasis mb-6">Load balancer rules of every account and region of the perimeter, read with the read-only
    <code>DmtDiscoveryRole</code>. Discovery runs on a schedule and on demand; idle shares are the hours without any request over the last 7 days.</p>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <NoticeToast :notice="notice" @close="notice = null" />

  <v-card class="dm-run mb-4" :loading="loading && !waiting">
    <div class="dm-run__sky" :data-mood="scanning ? 'load' : 'rest'" aria-hidden="true" />
    <DmLoader v-if="waiting" label="Reading the organization…" :size="56" />
    <v-card-text v-else-if="!lastRun" class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No discovery run yet.</span>
    </v-card-text>
    <v-card-text v-else class="dm-run__body">
      <div class="dm-run__icon">
        <DmLogo :state="scanning ? 'load' : 'wake'" :size="52" />
      </div>
      <div class="dm-run__main">
        <div class="dm-eyebrow">{{ lastRun.trigger }}<template v-if="lastRun.by"> by {{ lastRun.by }}</template></div>
        <div class="dm-run__headline">
          <span>Last run {{ relative(lastRun.startedAt, now) }}</span>
          <v-chip :color="runColor(lastRun.status)" variant="tonal" label size="small" class="dm-run__status">{{ lastRun.status }}</v-chip>
        </div>
        <div class="dm-run__tiles">
          <div v-for="t in runTiles" :key="t.key" class="dm-figure" :class="{ 'dm-figure--alarm': t.key === 'failed' && failed.length }">
            <v-avatar :color="t.color" variant="tonal" rounded="lg" size="34"><v-icon :icon="t.icon" size="18" /></v-avatar>
            <div class="dm-figure__text">
              <div class="dm-figure__value">{{ t.value }}</div>
              <div class="dm-figure__label">{{ t.label }}</div>
            </div>
          </div>
        </div>
        <v-alert v-if="lastRun.error" type="error" variant="tonal" density="compact" class="mt-4" :text="lastRun.error" />
        <p v-if="lastRun.skippedReason" class="text-body-medium text-medium-emphasis mt-3">Skipped: {{ lastRun.skippedReason }}.</p>
        <p v-if="refused" class="text-body-medium text-medium-emphasis mt-3">Run now {{ relative(refused.startedAt, now) }}<template v-if="refused.by"> by {{ refused.by }}</template> was refused: {{ refused.skippedReason }}.</p>
        <ul v-if="failed.length" class="dm-run__failed mt-4">
          <li v-for="t in failed" :key="`${t.account}/${t.region}`" class="text-body-medium">
            <v-icon :icon="mdiAlertCircleOutline" color="error" size="16" class="dm-run__failed-icon" />
            <span class="text-error">{{ targetText(t) }}</span>
          </li>
        </ul>
      </div>
    </v-card-text>
  </v-card>

  <LintAlert v-if="lastRun" :findings="lastRun.lint" :settings-link="session.isAdmin" />
  <OrganizationAccess v-if="access && access.checkedAt" :report="access" :roles="roles" />

  <v-card class="dm-candidates">
    <div v-if="status" class="dm-candidates__tabs">
      <v-chip-group :model-value="status" mandatory column @update:model-value="show">
        <v-tooltip v-for="s in visibleStatuses(counts, status)" :key="s" location="top" max-width="380">
          <template #activator="{ props }">
            <v-chip v-bind="props" :value="s" :color="statusColor(s)" variant="tonal" size="default" class="dm-tab">{{ statusLabel(s) }}
              <span class="dm-tab__count">{{ counts[s] ?? 0 }}</span></v-chip>
          </template>
          <StatusHelp :status="s" />
        </v-tooltip>
      </v-chip-group>
    </div>
    <v-divider v-if="status" />
    <div class="dm-candidates__tools">
      <v-text-field v-model="account" label="Account" placeholder="12 digits" density="compact" hide-details clearable max-width="220" class="dm-filter" @update:model-value="restartSoon" />
      <v-text-field v-model="region" label="Region" placeholder="eu-west-1" density="compact" hide-details clearable max-width="180" class="dm-filter" :disabled="!filtered" @update:model-value="restartSoon" />
      <v-spacer />
      <div v-if="session.canOperate && selected.length" class="dm-candidates__actions">
        <v-tooltip v-if="single?.operation" location="top" max-width="380" :text="`${operationLabel(single.operation.type, subjectOf(single))} is running: follow it in Operations.`">
          <template #activator="{ props }">
            <span v-bind="props"><v-btn variant="tonal" disabled><template #prepend><v-progress-circular indeterminate size="16" width="2" /></template>{{ single.operation.type === 'onboard' ? 'Onboarding…' : 'Offboarding…' }}</v-btn></span>
          </template>
        </v-tooltip>
        <v-tooltip v-else-if="onboardable && noCommand" location="top" max-width="380" :text="noCommand">
          <template #activator="{ props }"><span v-bind="props"><v-btn :prepend-icon="mdiPlusCircleOutline" variant="tonal" disabled>Onboard…</v-btn></span></template>
        </v-tooltip>
        <v-btn v-else-if="onboardable" :prepend-icon="mdiPlusCircleOutline" color="primary" variant="flat" @click="onboardOpen = true">Onboard…</v-btn>
        <v-btn v-if="offboardable && !single?.operation" :prepend-icon="mdiLogoutVariant" color="warning" variant="tonal" @click="offboard">Offboard</v-btn>
        <v-btn v-if="excludeOptions.length" :prepend-icon="mdiCancel" color="error" variant="tonal" @click="excludeOpen = true">Exclude…</v-btn>
        <v-btn v-if="selectedDismissed" :prepend-icon="mdiEyeOutline" variant="tonal" @click="changeDismissal('restore')">Restore ({{ selected.length }})</v-btn>
        <v-btn v-else :prepend-icon="mdiEyeOffOutline" variant="tonal" @click="dismissDialog = true">Dismiss ({{ selected.length }})</v-btn>
      </div>
    </div>
    <v-data-table v-model="selected" class="dm-table" :mobile="smAndDown" :headers="headers" :items="candidates" :loading="loading" item-value="id"
      :show-select="session.canOperate" :items-per-page="-1" hide-default-footer>
      <template #[`item.status`]="{ item }">
        <v-tooltip v-if="item.operation" location="top" max-width="380" :text="`${operationLabel(item.operation.type, subjectOf(item))} is running: open its steps in Operations.`">
          <template #activator="{ props }">
            <router-link v-bind="props" :to="{ path: '/operations', query: { id: item.operation.id } }" class="running"
              :aria-label="`${operationLabel(item.operation.type, subjectOf(item))} running: follow it in Operations`">
              <v-chip color="primary" variant="tonal" label><v-progress-circular indeterminate size="14" width="2" class="mr-2" />{{ item.operation.type === 'onboard' ? 'onboarding' : 'offboarding' }}</v-chip>
            </router-link>
          </template>
        </v-tooltip>
        <DiscoveryStatusChip v-else :status="item.status" />
      </template>
      <template #[`item.conditions`]="{ item }">
        <div class="dm-rule">
          <div class="dm-rule__host">{{ item.conditions }}</div>
          <div class="dm-rule__where">{{ item.loadBalancer }} · {{ item.listener }} · priority {{ item.priority }}
            <v-tooltip v-if="item.rules?.length > 1" location="top" max-width="520">
              <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="tonal" class="ml-1" tabindex="0">{{ item.rules.length }} rules</v-chip></template>
              <div v-for="line in ruleLines(item.rules)" :key="line">{{ line }}</div>
            </v-tooltip>
          </div>
        </div>
      </template>
      <template #[`item.account`]="{ item }">
        <div class="nowrap">{{ item.accountName }}</div>
        <div class="text-body-small text-medium-emphasis mono">{{ item.account }}</div>
      </template>
      <template #[`item.region`]="{ item }"><RegionLabel :region="item.region" /></template>
      <template #[`item.backend`]="{ item }">
        <BackendLabel v-if="item.backend" :backend="item.backend" :account="item.account" :region="item.region" />
        <span v-else-if="item.workloadId" class="text-medium-emphasis">workload {{ item.workload?.name ?? item.workloadId }}</span>
      </template>
      <template #[`item.idleHours7d`]="{ item }">
        <div v-if="item.idleHours7d !== null" class="dm-idle">
          <span class="dm-idle__share" aria-hidden="true">{{ idleShare(item) }}</span>
          <IdleBar :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d" />
        </div>
      </template>
      <template #[`item.statusReason`]="{ item }">
        <div class="dm-reason">
          <span v-if="item.status === 'managed' && item.workload" class="text-medium-emphasis">managed as
            <router-link :to="`/workloads/${item.workload.router}/${item.workload.workloadId}`">{{ item.workload.name }}</router-link></span>
          <span v-else class="text-medium-emphasis">{{ item.status === 'managed' && item.workloadId ? `managed as workload ${item.workloadId}` : item.statusReason }}</span>
        </div>
      </template>
      <template #[`item.firstSeenAt`]="{ item }"><span class="nowrap text-medium-emphasis dm-num">{{ relative(item.firstSeenAt, now) }}</span></template>
      <template #loading>
        <DmLoader label="Reading the candidates…" :size="40" class="dm-table__loader" />
      </template>
      <template #no-data>
        <div class="dm-calm justify-center py-6">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">No candidate here.</span>
        </div>
      </template>
    </v-data-table>
    <v-divider />
    <v-card-actions class="dm-candidates__foot">
      <span class="text-body-small text-medium-emphasis dm-num">{{ first }}–{{ last }}<template v-if="!filtered && status"> of {{ counts[status] ?? 0 }} (at the last change)</template></span>
      <v-spacer />
      <v-btn variant="text" :prepend-icon="mdiChevronLeft" :disabled="page === 0 || loading" @click="turn(-1)">Previous</v-btn>
      <v-btn variant="text" :append-icon="mdiChevronRight" :disabled="!hasNext || loading" @click="turn(1)">Next</v-btn>
    </v-card-actions>
  </v-card>

  <v-card id="exclusions" class="mt-4" title="Exclusions">
    <v-card-subtitle class="text-wrap">Target groups, load balancers and accounts kept away from Dormeto: discovery never proposes them, whatever
      the perimeter includes, and the managed workloads they match stay awake until offboarded.</v-card-subtitle>
    <v-list v-if="exclusions.length" lines="three" class="bg-transparent">
      <v-list-item v-for="e in exclusions" :key="e.id" :title="exclusionText(e.target)">
        <template #prepend>
          <v-avatar color="error" variant="tonal" rounded="lg" size="36" class="mr-1"><v-icon :icon="KIND_ICONS[e.target.kind] ?? mdiCancel" size="18" /></v-avatar>
        </template>
        <v-list-item-subtitle class="text-wrap">
          {{ e.reason }} · by {{ e.by }} {{ relative(e.at, now) }} · {{ e.expiresAt ? (e.expired ? `expired ${relative(e.expiresAt, now)}` : `expires ${relative(e.expiresAt, now)}`) : 'no expiry' }}
          <template v-if="e.paused?.length"> · {{ e.lifting ? 'still to resume' : 'paused' }} {{ e.paused.map((p) => `${p.name ?? p.workloadId} (${p.router})`).join(', ') }}</template>
        </v-list-item-subtitle>
        <template #append>
          <div class="d-flex flex-wrap align-center justify-end ga-2">
            <v-chip v-if="e.expired" variant="tonal" label>expired</v-chip>
            <v-chip v-if="e.lifting" color="warning" variant="tonal" label>lift incomplete</v-chip>
            <v-btn v-if="session.canOperate" variant="tonal" size="small" @click="lift(e)">{{ e.lifting ? 'Retry lift' : 'Lift' }}</v-btn>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-card-text v-else class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No exclusion. Select a candidate and choose Exclude to keep it, its load balancer or its account away from Dormeto.</span>
    </v-card-text>
  </v-card>

  <ExcludeDialog v-model="excludeOpen" :options="excludeOptions" @submit="exclude" />
  <OnboardDialog v-model="onboardOpen" :title="single?.conditions ?? ''" :default-name="single?.targetGroup ?? null" :kubernetes="singleKubernetes" :access="clusterAccess" @submit="onboard" />

  <v-dialog v-model="dismissDialog" max-width="480">
    <v-card class="dm-dialog">
      <v-card-item>
        <template #prepend>
          <v-avatar color="info" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiEyeOffOutline" size="20" /></v-avatar>
        </template>
        <v-card-title>Dismiss candidates</v-card-title>
      </v-card-item>
      <v-card-text>
        <p class="mb-4">The {{ selected.length }} selected rule{{ selected.length === 1 ? '' : 's' }} will stay dismissed, whatever later scans find, until restored.</p>
        <v-text-field v-model="note" label="Note (why)" maxlength="256" counter />
      </v-card-text>
      <v-card-actions class="px-6 pb-5">
        <v-spacer />
        <v-btn variant="text" @click="dismissDialog = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" @click="changeDismissal('dismiss')">Dismiss</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.running { text-decoration: none; }
/* Readable over the page: the overlay's glass, nearly opaque (the global glass of cards would let the page through). */
.v-card.dm-dialog:not(.v-card--variant-text):not(.v-card--variant-plain) { background: rgba(var(--v-theme-surface), 0.95) !important; }
.dm-lede { max-width: 78ch; }
.dm-num { font-variant-numeric: tabular-nums; }
/* An empty state: the sleeping icon and its sentence, centred in its card. */
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding-block: 24px !important; }

/* The last run: the icon (its sun turns while a run scans), the figures as tiles. */
.dm-run { position: relative; overflow: hidden; }
.dm-run__sky { position: absolute; inset: 0; pointer-events: none; transition: opacity 1.2s;
  background: radial-gradient(55% 140% at 0% 0%, rgba(var(--v-theme-primary), 0.12), transparent 65%), radial-gradient(40% 100% at 100% 100%, rgba(var(--v-theme-sun), 0.07), transparent 70%); }
.dm-run__sky[data-mood="load"] { background: radial-gradient(55% 140% at 0% 0%, rgba(var(--v-theme-primary), 0.22), transparent 65%), radial-gradient(40% 100% at 100% 100%, rgba(var(--v-theme-sun), 0.14), transparent 70%); }
.dm-run__body { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 24px; align-items: start; padding: 24px !important; }
.dm-run__icon { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.2); }
.dm-run__headline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 4px 0 16px; font-size: clamp(1.2rem, 1rem + 0.7vw, 1.5rem); font-weight: 600;
  letter-spacing: -0.03em; line-height: 1.2; }
.dm-run__status { font-family: var(--dm-mono); font-size: 0.72rem; letter-spacing: 0.04em; }
.dm-run__tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dm-figure { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 10px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px;
  background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-figure--alarm { border-color: rgba(var(--v-theme-error), 0.4); background: rgba(var(--v-theme-error), 0.06); }
.dm-figure__text { min-width: 0; }
.dm-figure__value { font-size: 1.45rem; font-weight: 600; line-height: 1.05; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
.dm-figure__label { font-size: 0.78rem; line-height: 1.25; opacity: 0.66; }
.dm-run__failed { list-style: none; display: grid; gap: 6px; margin-bottom: 0; padding: 0; }
.dm-run__failed li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: 12px; background: rgba(var(--v-theme-error), 0.06); }
.dm-run__failed-icon { margin-top: 2px; }

/* The candidates: status tabs with their counts, filters and actions, the table. */
.dm-candidates { overflow: hidden; }
.dm-candidates__tabs { padding: 10px 14px 4px; }
.dm-tab { font-weight: 500; }
.dm-tab__count { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.08); font: 500 0.72rem/1.4 var(--dm-mono);
  font-variant-numeric: tabular-nums; }
.dm-tab.v-chip--selected .dm-tab__count, .dm-tab.v-chip--active .dm-tab__count { background: rgba(var(--v-theme-on-surface), 0.12); }
.dm-candidates__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 16px; }
.dm-filter { flex: 1 1 160px; }
.dm-candidates__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dm-candidates__foot { padding: 8px 16px; }
.dm-table__loader { padding: 28px 16px; }
.dm-table :deep(th) { white-space: nowrap; padding-inline: 10px !important; }
.dm-table :deep(td) { padding: 10px !important; vertical-align: middle; }
.dm-table :deep(th:first-child), .dm-table :deep(td:first-child) { padding-left: 16px !important; }
.dm-table :deep(.backend-label .mono) { display: inline-block; max-width: 144px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.dm-rule { min-width: 176px; max-width: 300px; }
.dm-rule__host { font-weight: 500; overflow-wrap: anywhere; }
.dm-rule__where { margin-top: 2px; font-size: 0.78rem; opacity: 0.62; }
.dm-reason { min-width: 90px; max-width: 260px; }
.dm-idle { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.dm-idle__share { min-width: 3.4em; text-align: right; font: 500 0.74rem/1 var(--dm-mono); font-variant-numeric: tabular-nums; opacity: 0.75; }
.dm-idle :deep(.idle-bar) { width: 60px; margin-left: 0; }
.dm-idle :deep(.v-progress-linear) { border-radius: 999px; }
.dm-idle :deep(.v-progress-linear__background) { opacity: 0.14; }
.dm-idle :deep(.v-progress-linear__determinate) { border-radius: 999px; }

@media (max-width: 960px) {
  .dm-run__tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .dm-run__body { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 18px !important; }
  .dm-run__icon { width: 68px; height: 68px; }
  .dm-candidates__actions { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-run__sky { transition: none; }
}
</style>
