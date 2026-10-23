<script setup lang="ts">
import { useNow } from '../now';
import { computed, onMounted, ref } from 'vue';
import { mdiArrowLeft, mdiCancel, mdiCar, mdiCellphone, mdiChevronDown, mdiInformationOutline, mdiLeaf, mdiPencilOutline, mdiTagOutline, mdiLogoutVariant, mdiOpenInNew, mdiPause, mdiPlay, mdiPowerSleep, mdiWeatherSunny } from '@mdi/js';
import { settingRows } from '../settings';
import { freshBootLine, hibernationLine, readinessLine } from '../hibernation';
import HibernateDialog from '../components/HibernateDialog.vue';
import { backendIcon } from '../icons';
import { api } from '../api';
import { usePoll } from '../poll';
import { backendArn, backendLabel, backendService, duration, listSourceHref, targetInfo, usd, usdHourly, relative, routeColor, routeLabel, ruleText, shortId, stateColor, kubernetesOwner, switchText } from '../format';
import { equivalents, rounded } from '../energy';
import { useSession } from '../stores/session';
import { pauseLine, type TargetOption } from '../pause';
import ExcludeDialog from '../components/ExcludeDialog.vue';
import PauseChip from '../components/PauseChip.vue';
import PauseDialog from '../components/PauseDialog.vue';
import ResourceTooltip from '../components/ResourceTooltip.vue';
import DescriptionCard from '../components/DescriptionCard.vue';
import RenameDialog from '../components/RenameDialog.vue';
import TagsDialog from '../components/TagsDialog.vue';
import { tagsList, type Tags } from '../tags';
import NoticeAlert, { type Notice } from '../components/NoticeAlert.vue';
import StateBar from '../components/StateBar.vue';
import StateChip from '../components/StateChip.vue';
import HistoryCard from '../components/HistoryCard.vue';
import IdleWindowCard from '../components/IdleWindowCard.vue';
import RequestHeatmap from '../components/RequestHeatmap.vue';
import ScheduleCard from '../components/ScheduleCard.vue';
import ScheduleDialog from '../components/ScheduleDialog.vue';
import type { Schedule } from '../schedule';
import DmLogo from '../components/DmLogo.vue';
import DmLoader from '../components/DmLoader.vue';
import { stateSince } from '../state';
import { backendCost, barSavings, discountText } from '../costs';
import type { Backend } from '../types';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import { failureTitle } from '../failures';
import { useCountUp } from '../count-up';
import type { Counts, DescriptionInfo, WorkloadStatus } from '../types';

const now = useNow();
const props = defineProps<{ router: string; id: string }>();
const session = useSession();
const status = ref<WorkloadStatus | null>(null);
const url = ref<string | null>(null);
const confirm = ref<'nap' | 'wake' | 'offboard' | null>(null);
const acting = ref(false);
const notice = ref<Notice | null>(null);
const pauseOpen = ref(false);
const excludeOpen = ref(false);
const renameOpen = ref(false);
const tagsOpen = ref(false);
const scheduleOpen = ref(false);
const hibernateOpen = ref(false);
const savingHibernate = ref(false);
const scheduleError = ref('');
const savingSchedule = ref(false);
// R11: what the caller's grants allow on this workload; an API before the tags (no `can`) leaves it to the role.
const canWake = computed(() => status.value?.can?.wake ?? session.canOperate);
const canNap = computed(() => status.value?.can?.nap ?? session.canOperate);
const tags = computed(() => tagsList(status.value?.tags));
// The name people gave the workload (routers 0.20.0 and later), else its id.
const title = computed(() => status.value?.name ?? props.id);
const path = computed(() => `/workloads/${encodeURIComponent(props.router)}/${encodeURIComponent(props.id)}`);

const { error, loading, nextAt, run } = usePoll(async () => {
  status.value = await api<WorkloadStatus>(path.value);
  url.value = status.value.url ?? '';
});

async function rename(name: string) {
  renameOpen.value = false;
  try {
    await api(`${path.value}/rename`, { method: 'POST', body: JSON.stringify({ name }) });
    notice.value = { type: 'success', text: `Renamed ${name}.` };
    await run();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

// Hibernation: operators and administrators change a manager workload's own value (null: inherit); the router's refusals
// (a Terraform workload, a router before 0.32.0) come back as the notice.
const hibernated = computed(() => status.value?.state === 'ASLEEP' && (status.value.hibernated === true || Boolean(status.value.hibernation?.instances?.some((i) => i.hibernated))));
// Hibernation applies to standalone EC2 instances only (never Auto Scaling groups, ECS, Kubernetes or databases).
const standalone = computed(() => Boolean(status.value?.backends.some((b) => b.kind === 'instance')));
async function setHibernate(hibernate: boolean | null) {
  savingHibernate.value = true;
  try {
    await api(`${path.value}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate }) });
    hibernateOpen.value = false;
    notice.value = { type: 'success', text: 'Hibernation saved: it applies from the next nap.' };
    await run();
  } catch (err) {
    hibernateOpen.value = false;
    notice.value = { type: 'error', text: (err as Error).message };
  } finally {
    savingHibernate.value = false;
  }
}

// The description (manager 0.19.0), read from the manager alone so that it shows while the router cannot be reached;
// undefined until read, and when the read fails: the card shows nothing then. Operators and administrators write it, as
// they rename; the refusal stays in the dialog, and a write shows what the manager answered.
const description = ref<DescriptionInfo | null | undefined>(undefined);
const savingDescription = ref(false);
const descriptionError = ref('');
onMounted(async () => {
  try {
    description.value = (await api<{ description: DescriptionInfo | null }>(`${path.value}/description`)).description;
  } catch {
    // Nothing rather than an invitation to write over a text that may exist.
  }
});
async function writeDescription(call: { method: 'PUT'; body: string } | { method: 'DELETE' }) {
  savingDescription.value = true;
  descriptionError.value = '';
  try {
    description.value = (await api<{ description: DescriptionInfo | null }>(`${path.value}/description`, call)).description;
  } catch (err) {
    descriptionError.value = (err as Error).message;
  } finally {
    savingDescription.value = false;
  }
}
const saveDescription = (text: string) => writeDescription({ method: 'PUT', body: JSON.stringify({ text }) });
const clearDescription = () => writeDescription({ method: 'DELETE' });

async function setTags(next: Tags) {
  tagsOpen.value = false;
  try {
    await api(`${path.value}/tags`, { method: 'PUT', body: JSON.stringify({ tags: next }) });
    notice.value = { type: 'success', text: 'Tags saved.' };
    await run();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

// R12: the schedule needs both permissions; the router's refusals (a 400 with its problems) stay in the dialog.
const canSchedule = computed(() => canWake.value && canNap.value);
async function saveSchedule(schedule: Schedule) {
  savingSchedule.value = true;
  scheduleError.value = '';
  try {
    await api(`${path.value}/schedule`, { method: 'PUT', body: JSON.stringify(schedule) });
    scheduleOpen.value = false;
    notice.value = { type: 'success', text: 'Schedule saved.' };
    await run();
  } catch (err) {
    scheduleError.value = (err as Error).message;
  } finally {
    savingSchedule.value = false;
  }
}

async function clearSchedule() {
  try {
    await api(`${path.value}/schedule`, { method: 'DELETE' });
    scheduleOpen.value = false;
    notice.value = { type: 'success', text: 'Schedule cleared.' };
    await run();
  } catch (err) {
    // From the dialog, the refusal stays in it; from the card, it is a notice.
    if (scheduleOpen.value) scheduleError.value = (err as Error).message;
    else notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function act(action: 'nap' | 'wake' | 'offboard') {
  confirm.value = null;
  if (action === 'offboard') {
    try {
      const { operation } = await api<{ operation: { id: string } }>('/operations', { method: 'POST', body: JSON.stringify({ type: 'offboard', router: props.router, workloadId: props.id }) });
      notice.value = { type: 'success', text: `Offboarding started (operation ${operation.id}): the workload is woken, then its instrumentation removed.`, operation: operation.id };
    } catch (err) {
      notice.value = { type: 'error', text: (err as Error).message };
    }
    return;
  }
  acting.value = true;
  try {
    await api(`${path.value}/${action}`, { method: 'POST' });
    notice.value = { type: 'success', text: action === 'nap' ? 'Nap requested: the route switches to the waker, then the backends stop.' : 'Wake requested.' };
    setTimeout(run, 2000);
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  } finally {
    acting.value = false;
  }
}

// Pauses: the workload's own (resumed here), an exclusion's (lifted in Discovery), the router's (resumed in Routers).
const pauses = computed(() => status.value?.pauses ?? []);
const ownPause = computed(() => pauses.value.find((p) => p.scope === 'workload' && !p.exclusionId));
const excluded = computed(() => pauses.value.some((p) => p.exclusionId));
// What a backend is, then what it runs: an Auto Scaling group's capacities, a Kubernetes owner's replicas and switch.
function backendDetails(b: Backend): string {
  const parts: (string | false | null | undefined)[] = [backendLabel(b.kind), b.companion && 'companion', b.cluster && `cluster ${b.cluster}`];
  if (b.kind === 'asg') parts.push(`min ${b.min} · desired ${b.desired} · max ${b.max}`, b.warmPool && `warm pool ${b.warmPool.state} (${b.warmPool.size})`);
  if (b.kind === 'k8s') parts.push(`${b.replicas} replica${b.replicas === 1 ? '' : 's'}`, b.keda && 'KEDA', b.switch && switchText(b.switch));
  return parts.filter(Boolean).join(' · ');
}

// A backend's costs in its tooltip (user request): its list price an hour and a month, its saving a month at the rate of
// the last 30 days, what is not priced.
function costRows(b: Backend): { label: string; value: string }[] {
  const cost = backendCost(b, status.value?.backends ?? [], status.value?.costs);
  if (!status.value?.costs) return [];
  if (!cost) return [{ label: 'Cost', value: 'known from its next nap (router 0.27.0 or later)' }];
  const shared = cost.shared > 1 ? ` (its ${cost.shared} backends of this kind together)` : '';
  return [
    ...(cost.hourly === null ? [] : [{ label: 'Base cost', value: `${usdHourly(cost.hourly)} an hour · ${usd(cost.monthly!)} a month${shared}` }]),
    ...(cost.savedMonthly === null ? [] : [{ label: 'Saved', value: `about ${usd(cost.savedMonthly)} a month at the last 30 days' rate` }]),
    ...(cost.unpriced.length ? [{ label: 'Not priced', value: cost.unpriced.join(', ') }] : []),
  ];
}
// R9.5: Spot at Spot prices, the discounts when set.
const costNote = computed(() => {
  const d = status.value?.costs?.discounts;
  // Kubernetes workloads (R10.5): what the pods' price supposes, and what keeps running.
  const kubernetes = status.value?.backends.some((b) => b.kind === 'k8s')
    ? ' Pods count as the pods\' share of their nodes, where an autoscaler removes the nodes they free; the EKS control plane and the nodes\' DaemonSets keep running.' : '';
  return `AWS list prices of what its last nap stopped, Spot at Spot prices${d ? `, after discounts (${discountText(d)})` : ''}; a month is 730 hours.${kubernetes}`;
});

// Where the workload is: the ARNs of its backends and targets.
const where = computed(() => ({ account: status.value?.account ?? '', region: status.value?.region ?? '' }));
const excludeOptions = computed<TargetOption[]>(() => (status.value?.targetGroupArn
  ? [{ kind: 'target-group', arn: status.value.targetGroupArn, label: `Target group ${shortId(status.value.targetGroupArn.replace(/\/[0-9a-f]+$/, ''))} (this workload)` }]
  : []));

async function change(action: 'pause' | 'resume', body?: object) {
  pauseOpen.value = false;
  acting.value = true;
  try {
    const result = await api<{ woken?: string[]; resumed?: boolean }>(`${path.value}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
    notice.value = { type: 'success', text: action === 'pause' ? `Paused: never napped until resumed${result.woken?.length ? '; waking it now' : ''}.` : 'Resumed: it naps again when idle.' };
    await run();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  } finally {
    acting.value = false;
  }
}

async function exclude(body: object) {
  excludeOpen.value = false;
  acting.value = true;
  try {
    const { operation } = await api<{ operation: { id: string } }>('/exclusions', { method: 'POST', body: JSON.stringify({ ...body, workload: { router: props.router, id: props.id } }) });
    notice.value = { type: 'success', text: `Excluded: it is being paused (operation ${operation.id}): woken and never napped, waiting for offboarding. Lift the exclusion in Discovery.`, operation: operation.id };
    setTimeout(run, 3000);
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  } finally {
    acting.value = false;
  }
}

const stats = computed(() => {
  const s = status.value?.stats;
  return s && 'total' in s ? s : null;
});
const statsError = computed(() => {
  const s = status.value?.stats;
  return s && 'error' in s ? s.error : '';
});
const rows = (kind: keyof Counts) => {
  const s = stats.value;
  if (!s) return [];
  return Object.keys(s.total[kind]).sort((a, b) => (s.total[kind][b] ?? 0) - (s.total[kind][a] ?? 0))
    .map((key) => ({ key, today: s.today[kind][key] ?? 0, total: s.total[kind][key] ?? 0 }));
};
// The last failure (R7b): where, when, how many in a row, and when a request may retry it.
const failureDetail = computed(() => {
  const s = status.value;
  if (!s?.failure) return '';
  const n = s.consecutiveFailures ?? 1;
  const retry = s.state !== 'FAILED' ? 'the next request wakes it again'
    : s.nextAttemptAt && Date.parse(s.nextAttemptAt) > now.value ? `next attempt ${relative(s.nextAttemptAt, now.value)}` : 'the next request retries it';
  return [s.failure.backend && `backend ${s.failure.backend}`, relative(s.failure.at, now.value), n > 1 && `${n} failures in a row`, retry].filter(Boolean).join(' · ');
});
const fallbackText = computed(() => (status.value?.fallbacks ?? []).map((f) => `${f.instance} on ${f.to} instead of ${f.from}`).join(', '));

const summary = computed(() => {
  const s = status.value;
  if (!s) return [];
  const since = stateSince(s);
  return [
    { label: 'Route', value: routeLabel(s.route) },
    { label: 'Nap', value: pauses.value.length ? 'never while paused' : s.nap ? (s.nap.inSeconds > 0 ? `eligible in ${duration(s.nap.inSeconds)}` : 'due at the next idle check (every 5 min)') : '—' },
    { label: 'Last request', value: relative(s.lastRequestAt, now.value) },
    { label: since.label, value: relative(since.at, now.value) },
    { label: 'Wakes', value: String(s.wakeCount) },
    { label: 'Held requests', value: String(s.holders) },
    { label: 'Pending wake', value: s.pendingWake ? 'yes' : 'no' },
    { label: 'Workload id', value: s.workloadId },
  ];
});

// The hero's icon (guide): asleep, napping or waking (its rays turn), awake; failed or unknown awake, its chip says it.
const mood = computed<'sleep' | 'load' | 'wake'>(() => {
  const s = status.value?.state;
  if (!s) return error.value ? 'wake' : 'load';
  return s === 'ASLEEP' ? 'sleep' : s === 'NAPPING' || s === 'WAKING' ? 'load' : 'wake';
});
const sky = computed(() => (status.value?.state === 'FAILED' ? 'failed' : mood.value));
const since = computed(() => {
  const s = status.value;
  if (!s) return null;
  const at = stateSince(s);
  return at.at ? { label: at.label, when: relative(at.at, now.value) } : null;
});
// The costs area: what its naps saved in the last 30 days, a month at that rate, the base cost an hour (as its 7-day bar
// says them), and the energy its naps did not use, with its carbon (the API's estimate, with its costs).
const savings = computed(() => barSavings(status.value?.costs));
const energy = computed(() => (status.value?.energy?.estimated ? status.value.energy : null));
const everyday = computed(() => {
  if (!energy.value) return [];
  const [phone, , , car] = equivalents(energy.value);
  return [{ ...phone!, icon: mdiCellphone }, { ...car!, icon: mdiCar }];
});
// The figures count up when they arrive (presentation: the conditions read the values themselves).
const savedUp = useCountUp(() => savings.value?.saved.usd ?? 0);
const monthlyUp = useCountUp(() => savings.value?.monthly ?? 0);
const hourlyUp = useCountUp(() => savings.value?.hourly ?? 0);
const kwhUp = useCountUp(() => energy.value?.kwh ?? 0);
const co2Up = useCountUp(() => energy.value?.co2Kg ?? 0);
</script>
<template>
  <!-- The hero, the page's header: the workload's state as the Dormeto icon, where it runs, its 7-day bar, its actions. -->
  <v-card data-test="header" class="dm-hero mb-4">
    <div class="dm-hero__sky" :data-mood="sky" aria-hidden="true" />
    <div class="dm-hero__body">
      <div class="dm-hero__icon"><DmLogo :state="mood" :size="88" /></div>
      <div class="dm-hero__main">
        <div class="dm-hero__head">
        <div class="dm-hero__where">
          <v-btn :icon="mdiArrowLeft" variant="text" size="small" density="comfortable" to="/workloads" aria-label="Back to the workloads" class="dm-hero__back" />
          <span class="dm-eyebrow">Fleet</span>
          <span class="dm-hero__sep" aria-hidden="true">/</span>
          <span v-if="session.isMember" data-test="router-text" class="dm-hero__router">{{ router }}</span>
          <router-link v-else :to="`/routers/${encodeURIComponent(router)}`" class="dm-hero__router">{{ router }}</router-link>
          <template v-if="status?.region"><span class="dm-hero__sep" aria-hidden="true">·</span><span class="dm-hero__region">{{ status.region }}</span></template>
        </div>
        <h1 class="text-headline-small dm-hero__title">{{ title }}</h1>
        </div>
        <div class="dm-hero__info">
        <div class="dm-hero__chips">
          <StateChip v-if="status" :state="status.state" :failure="status.failure" />
          <v-chip v-if="hibernated" data-test="hibernated" size="small" variant="tonal" label>hibernated</v-chip>
          <PauseChip :pauses="pauses" />
          <span v-if="since" class="dm-hero__since">{{ since.label }} <strong>{{ since.when }}</strong></span>
          <a v-if="url" :href="url" target="_blank" rel="noopener" class="dm-hero__url">{{ url.replace('https://', '').replace(/\/$/, '') }}<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
        </div>
        <!-- R11: its tags (Dormeto's own labels); administrators edit a manager workload's, a Terraform one's are set there. -->
        <div v-if="status" class="dm-hero__tags" data-test="tags">
          <v-icon :icon="mdiTagOutline" size="16" class="text-medium-emphasis" aria-hidden="true" />
          <v-chip v-for="t in tags" :key="t.key" data-test="tag" size="small" label variant="tonal">{{ t.text }}</v-chip>
          <span v-if="!tags.length" class="text-body-small text-medium-emphasis">{{ status.tags ? 'No tags' : 'Tags unknown (router before 0.30.0)' }}</span>
          <span v-if="status.source === 'terraform'" data-test="tags-terraform" class="text-body-small text-medium-emphasis">set in Terraform</span>
          <v-btn v-else-if="session.isAdmin && status.source === 'manager' && status.tags" data-test="edit-tags" :prepend-icon="mdiPencilOutline" variant="text" size="x-small" @click="tagsOpen = true">Edit tags</v-btn>
        </div>
        <StateBar v-if="status" block legend class="dm-hero__week" :states="status.states7d" :idle-hours7d="status.idleHours7d" :requests7d="status.requests7d" :savings="barSavings(status.costs)" :width="140" />
        </div>
      </div>
      <div class="dm-hero__side">
        <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
        <!-- Its actions in one menu (user request): wake and nap when its state allows, pause or resume, rename and offboard what
             the manager onboarded (offboard also a workload of a router it did not install), exclude its target group. -->
        <v-menu v-if="status && (session.canOperate || canWake || canNap)" location="bottom end">
          <template #activator="{ props: menu }">
            <v-btn v-bind="menu" data-test="actions" color="primary" variant="flat" :append-icon="mdiChevronDown" :disabled="acting" class="dm-hero__actions">Actions</v-btn>
          </template>
          <v-list density="compact" min-width="220">
            <v-list-item v-if="canWake" data-test="action" :prepend-icon="mdiWeatherSunny" title="Wake" :disabled="!['ASLEEP', 'FAILED', 'NAPPING'].includes(status.state)" @click="confirm = 'wake'" />
            <v-list-item v-if="canNap" data-test="action" :prepend-icon="mdiPowerSleep" title="Nap" :disabled="status.state !== 'AWAKE' || pauses.length > 0" @click="confirm = 'nap'" />
            <template v-if="canNap">
              <v-list-item v-if="ownPause" data-test="action" :prepend-icon="mdiPlay" title="Resume" @click="change('resume')" />
              <v-list-item v-else data-test="action" :prepend-icon="mdiPause" title="Pause" @click="pauseOpen = true" />
            </template>
            <v-list-item v-if="session.canOperate && status.source === 'manager'" data-test="action" :prepend-icon="mdiPencilOutline" title="Rename" @click="renameOpen = true" />
            <v-list-item v-if="session.canOperate && !excluded && excludeOptions.length" data-test="action" :prepend-icon="mdiCancel" title="Exclude" @click="excludeOpen = true" />
            <template v-if="session.canOperate && status.source !== 'terraform'">
              <v-divider class="my-1" />
              <v-list-item data-test="action" :prepend-icon="mdiLogoutVariant" title="Offboard" base-color="error" @click="confirm = 'offboard'" />
            </template>
          </v-list>
        </v-menu>
      </div>
    </div>
  </v-card>
  <NoticeAlert v-if="notice" :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-if="pauses.length" type="info" variant="tonal" class="mb-4 dm-alert-links" :title="excluded ? 'Excluded: never napped, waiting for offboarding' : 'Paused: never napped, requests still wake it'">
    <div v-for="p in pauses" :key="`${p.scope}/${p.exclusionId ?? ''}`" class="text-body-medium">
      {{ pauseLine(p, now) }}
      <template v-if="!session.isMember">
        <router-link v-if="p.exclusionId" to="/discovery" class="ml-1">Lift the exclusion in Discovery</router-link>
        <router-link v-else-if="p.scope === 'router'" to="/routers" class="ml-1">Resume the router</router-link>
      </template>
    </div>
  </v-alert>
  <v-alert v-if="status?.failure" data-test="failure" :type="status.state === 'FAILED' ? 'error' : 'warning'" variant="tonal" class="mb-4" :title="failureTitle(status.failure)">
    <div class="text-body-medium">{{ status.failure.message }}</div>
    <div class="text-body-small text-medium-emphasis mt-1">{{ failureDetail }}</div>
  </v-alert>
  <v-alert v-if="fallbackText" data-test="fallbacks" type="info" variant="tonal" class="mb-4" title="On fallback instance types">
    {{ fallbackText }}: AWS had no capacity for their own types at the last wake; the next nap gives them back.
  </v-alert>
  <v-card v-if="loading && !status"><DmLoader label="Reading the workload…" /></v-card>
  <DescriptionCard class="mb-4" :description="description" :can-edit="session.canOperate" :subject="title" :saving="savingDescription" :error="descriptionError"
    @save="saveDescription" @clear="clearDescription" />

  <!-- Two columns of cards, 16 px apart: the backends, history, requests and idle window (wide content) on the left; the summary, rules,
       targets, filtering and settings (short ones) on the right, so both end at about the same height. -->
  <div v-if="status" class="dm-layout">
    <div v-if="status.recommendations.length" class="dm-stack dm-layout__wide">
      <v-alert v-for="r in status.recommendations" :key="r.backend" type="info" variant="tonal" :title="`Recommendation for ${shortId(r.backend)}`" :text="r.message" />
    </div>

    <div class="dm-stack">
      <v-card title="Backends">
        <v-list density="comfortable" class="bg-transparent">
          <ResourceTooltip v-for="b in status.backends" :id="b.id" :key="b.id" :arn="backendArn(b, where)" :service="backendService(b.kind)" :rows="costRows(b)"
            :note="costRows(b).some((r) => r.label === 'Base cost') ? costNote : null">
            <template #default="{ tip }">
              <v-list-item v-bind="tip" data-test="backend" :title="b.kind === 'k8s' ? kubernetesOwner(b.id) : shortId(b.id)" class="dm-backend">
                <template v-if="backendIcon(b.kind)" #prepend>
                  <img :src="backendIcon(b.kind)!" :alt="backendLabel(b.kind)" width="36" height="36" class="mr-3 backend-icon">
                </template>
                <!-- Its details under its name, wrapped: beside the state they crushed the name at a phone's width. -->
                <v-list-item-subtitle class="text-wrap">{{ backendDetails(b) }}</v-list-item-subtitle>
                <template #append>
                  <v-chip :color="b.status === 'running' ? 'success' : b.status === 'stopped' ? 'info' : 'warning'" variant="tonal" label>{{ b.status }}</v-chip>
                </template>
              </v-list-item>
            </template>
          </ResourceTooltip>
        </v-list>
        <v-card-text v-if="status.ignoredTargets.length" class="pt-0 text-body-small">Ignored: {{ status.ignoredTargets.map((t) => `${t.id} (${t.reason})`).join(', ') }}</v-card-text>
        <div v-if="status.costs && savings" class="dm-costs">
          <div class="dm-eyebrow mb-3">Costs · last 30 days</div>
          <div class="dm-costs__figures">
            <div class="dm-figure">
              <div :class="['dm-figure__value', { 'text-success': savings.saved.usd > 0 }]">{{ !savings.saved.usd && savings.saved.unpricedHours ? 'not priced yet' : usd(savedUp) }}</div>
              <div class="dm-figure__label">saved by its naps{{ savings.saved.usd && savings.saved.unpricedHours ? ', part not priced' : '' }}</div>
            </div>
            <div v-if="typeof savings.monthly === 'number'" class="dm-figure">
              <div class="dm-figure__value">{{ usd(monthlyUp) }}</div>
              <div class="dm-figure__label">a month at that rate</div>
            </div>
            <div v-if="typeof savings.hourly === 'number'" class="dm-figure">
              <div class="dm-figure__value">{{ usdHourly(hourlyUp) }}</div>
              <div class="dm-figure__label">base cost an hour</div>
            </div>
          </div>
          <div v-if="energy" data-test="energy" class="dm-energy">
            <v-avatar color="success" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiLeaf" size="20" /></v-avatar>
            <div class="dm-energy__main">
              <div class="dm-energy__label">Energy not used (estimate)</div>
              <div class="dm-energy__values">
                <span><strong>{{ rounded(kwhUp) }}</strong> kWh</span>
                <span class="text-success"><strong>{{ rounded(co2Up) }}</strong> kg CO₂e</span>
              </div>
              <div class="dm-energy__everyday">
                <span v-for="e in everyday" :key="e.text" class="dm-energy__equiv"><v-icon :icon="e.icon" size="15" />≈ {{ rounded(e.value) }} {{ e.text }}</span>
              </div>
              <div class="dm-energy__note">Cloud Carbon Footprint's coefficients for AWS; not a measure.</div>
            </div>
          </div>
          <div class="dm-costs__note">{{ costNote }}</div>
        </div>
      </v-card>
      <HistoryCard :router="router" :id="id" :now="now" />
      <RequestHeatmap :router="router" :id="id" />
      <ScheduleCard :schedule="status.schedule" :next="status.next" :maintenance-due="status.maintenanceDue" :can-edit="canSchedule" @edit="scheduleError = ''; scheduleOpen = true" @clear="clearSchedule" />
      <IdleWindowCard :router="router" :id="id" />
    </div>

    <div class="dm-stack">
      <v-card title="Summary">
        <v-table density="compact" class="dm-summary">
          <tbody>
            <tr v-for="row in summary" :key="row.label"><th class="text-medium-emphasis font-weight-regular">{{ row.label }}</th><td :class="{ mono: row.label === 'Workload id' }">{{ row.value }}</td></tr>
          </tbody>
        </v-table>
      </v-card>
      <v-card v-if="status.rules?.length || status.issues?.length" :title="(status.rules?.length ?? 0) > 1 ? `Rules (${status.rules!.length}, found from the target group)` : 'Rule'">
        <v-alert v-if="status.issues?.length" type="warning" variant="tonal" density="compact" class="mx-4 mt-2"
          title="Not napped: some rules cannot be switched">
          <div v-for="issue in status.issues" :key="issue" class="text-body-small">{{ issue }}</div>
          <div class="text-body-small mt-1">Add the waker target group and the <code>dormeto:workload</code> tag to these rules, or remove them.</div>
        </v-alert>
        <v-list density="compact" class="py-0 bg-transparent dm-wrap">
          <v-list-item v-for="r in status.rules" :key="r.arn" :title="r.conditions" :subtitle="r.issue ?? `priority ${r.priority ?? '—'}`">
            <template #append>
              <v-chip v-if="r.issue" color="warning" variant="tonal" label size="small">not switched</v-chip>
              <v-chip v-else :color="routeColor(r.route)" variant="tonal" label size="small">{{ r.route === 'app' ? 'application' : r.route }}</v-chip>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
      <v-card v-if="status.drift?.length" title="Drift repaired">
        <v-card-subtitle class="text-wrap">Infrastructure as code changed what onboarding added; the router put it back.</v-card-subtitle>
        <v-list density="compact" class="py-0 bg-transparent dm-wrap">
          <v-list-item v-for="(d, i) in status.drift" :key="`${d.at}-${i}`" :title="d.kind" :subtitle="`${d.detail} · ${relative(d.at, now)} · ${d.by}`" />
        </v-list>
      </v-card>
      <v-card title="Targets">
        <v-card-text>
          <span v-if="!status.targets.length" class="text-medium-emphasis">No registered target.</span>
          <ResourceTooltip v-for="t in status.targets" :id="t.id" :key="t.id" :arn="targetInfo(t.id, where, status.backends).arn" :service="targetInfo(t.id, where, status.backends).service">
            <template #default="{ tip }">
              <v-chip v-bind="tip" data-test="target" class="mr-2 mb-2" :color="t.state === 'healthy' ? 'success' : 'warning'" variant="tonal" label tabindex="0">
                <span class="mono">{{ t.id }}</span>&nbsp;{{ t.state }}
              </v-chip>
            </template>
          </ResourceTooltip>
        </v-card-text>
      </v-card>
      <v-card :title="`Requests while not awake (today · ${stats?.days ?? 7} days)`">
        <v-card-text v-if="statsError" class="text-error">{{ statsError }}</v-card-text>
        <div v-else class="dm-requests">
          <div v-for="kind in (['ignored', 'deferred', 'wakes'] as const)" :key="kind">
            <div class="dm-subhead mb-2">{{ { ignored: 'Ignored', deferred: 'Deferred', wakes: 'Wakes by trigger' }[kind] }}</div>
            <div v-if="!rows(kind).length" class="text-medium-emphasis text-body-medium">none</div>
            <div v-for="row in rows(kind)" :key="row.key" class="d-flex ga-2 text-body-medium py-1 dm-count-row">
              <span class="flex-grow-1 dm-count-row__key">{{ row.key }}</span><span class="nowrap dm-num"><span class="text-medium-emphasis">{{ row.today }}</span> · <strong>{{ row.total }}</strong></span>
            </div>
          </div>
        </div>
      </v-card>
      <v-card title="Wake filtering" class="dm-links">
        <v-card-text>
          <div class="mb-3"><strong>Mode:</strong> {{ status.wakeMode === 'browser' ? 'browser (only the waiter page probe, the x-dormeto-wake header or a wake rule wakes)' : 'any request that passes the filters wakes' }}</div>
          <div v-for="r in [...status.noWakeRules, ...status.wakeRules]" :key="`${r.level}/${r.name}`" class="mb-2 text-body-medium">
            <v-chip :color="r.level === 'wake' ? 'success' : 'secondary'" variant="tonal" label class="mr-2">{{ r.level === 'wake' ? 'wake' : `no-wake · ${r.level}` }}</v-chip>
            <strong>{{ r.name }}</strong>: <span :class="{ 'text-error': r.invalid }">{{ r.invalid ? `invalid, ${r.invalid}` : ruleText(r.conditions) }}</span>
          </div>
          <div v-if="status.ipLists.length" class="mt-4">
            <div class="dm-subhead">IP reputation lists</div>
            <div class="text-body-small text-medium-emphasis mb-2">Lists of scanner and cloud networks, public or stored in S3, set on the router and applied to all its workloads; the router downloads them again daily by default.</div>
            <div v-for="l in status.ipLists" :key="l.name" class="text-body-medium">
              <a v-if="listSourceHref(l.url)" :href="listSourceHref(l.url) ?? undefined" target="_blank" rel="noopener" :title="l.url">{{ l.name }}</a><span v-else>{{ l.name }}</span>
              <v-tooltip location="top" max-width="340" open-on-click open-on-focus>
                <template #activator="{ props }"><span v-bind="props" class="setting text-medium-emphasis" tabindex="0"> ({{ l.action }})</span></template>
                {{ l.action === 'ignore'
                  ? 'Requests from a listed address never wake the workload, the waiting page probe included.'
                  : 'Requests from a listed address get the waiting page; only the page\'s own script wakes the workload, so a real visitor still gets in and a scanner never wakes it.' }}
              </v-tooltip>:
              <span :class="{ 'text-error': l.error }">{{ l.error ?? `${l.entries.toLocaleString()} entries, downloaded ${relative(l.fetchedAt, now)}` }}</span>
            </div>
          </div>
        </v-card-text>
      </v-card>
      <v-card title="Settings">
        <v-card-text class="d-flex flex-wrap align-center ga-2 text-body-medium">
          <v-tooltip v-for="row in settingRows(status.settings)" :key="row.key" location="top" max-width="380" open-on-click open-on-focus>
            <template #activator="{ props }">
              <span v-bind="props" class="setting dm-setting" tabindex="0" :aria-label="`${row.label} ${row.value}: ${row.help} ${row.range}`">
                {{ row.label }} <strong>{{ row.value }}</strong><v-icon :icon="mdiInformationOutline" size="x-small" class="ml-1 text-medium-emphasis" />
              </span>
            </template>
            <div class="text-body-medium">{{ row.help }}</div>
            <div class="text-body-small mt-2"><strong>Acceptable:</strong> {{ row.range }}</div>
          </v-tooltip>
          <v-spacer />
          <span class="text-medium-emphasis dm-version">Router {{ status.router.version }} ({{ status.router.build }})</span>
        </v-card-text>
        <v-card-text v-if="status.hibernation && !standalone" data-test="hibernate" class="pt-0 text-body-medium">
          Hibernate: <strong>does not apply</strong> (standalone EC2 instances only)
        </v-card-text>
        <v-card-text v-else-if="status.hibernation" data-test="hibernate" class="pt-0 text-body-medium">
          <div class="d-flex flex-wrap align-center ga-2">
            <span>Hibernate <strong>{{ hibernationLine(status.hibernation) }}</strong></span>
            <v-spacer />
            <span v-if="status.source === 'terraform'" class="text-body-small text-medium-emphasis">set hibernate in its workload module</span>
            <v-btn v-else-if="session.canOperate && status.source === 'manager'" data-test="edit-hibernate" :prepend-icon="mdiPencilOutline" variant="text" size="x-small" @click="hibernateOpen = true">Edit</v-btn>
          </div>
          <div v-if="readinessLine(status.hibernation)" class="text-body-small text-medium-emphasis">{{ readinessLine(status.hibernation) }}</div>
          <div v-if="freshBootLine(status.hibernation)" class="text-body-small text-medium-emphasis">{{ freshBootLine(status.hibernation) }}</div>
        </v-card-text>
      </v-card>
    </div>
  </div>

  <HibernateDialog v-if="status?.hibernation" v-model="hibernateOpen" :subject="title" :current="status.hibernation.workload" :saving="savingHibernate" @submit="setHibernate" />
  <PauseDialog v-model="pauseOpen" :subject="title" :can-wake="canWake" @submit="change('pause', $event)" />
  <ExcludeDialog v-model="excludeOpen" :options="excludeOptions" @submit="exclude" />
  <v-dialog :model-value="confirm !== null" max-width="460" @update:model-value="confirm = null">
    <v-card :title="confirm === 'nap' ? `Nap ${title}?` : confirm === 'offboard' ? `Offboard ${title}?` : `Wake ${title}?`">
      <template #prepend>
        <v-avatar :color="confirm === 'nap' ? stateColor('ASLEEP') : confirm === 'offboard' ? 'error' : 'primary'" variant="tonal" rounded="lg" size="36">
          <v-icon :icon="confirm === 'nap' ? mdiPowerSleep : confirm === 'offboard' ? mdiLogoutVariant : mdiWeatherSunny" size="20" />
        </v-avatar>
      </template>
      <v-card-text class="text-medium-emphasis">{{ confirm === 'nap'
        ? 'The route switches to the waker and the backends stop after the drain. The next request wakes the workload again.'
        : confirm === 'offboard'
          ? 'The workload is woken, then Dormeto removes what onboarding added: the waker from its rules, the waker target group, the tags. A workload written in Terraform is offboarded by removing its workload module.'
          : 'The backends start now; the route switches back to the application once a target is healthy.' }}</v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="confirm = null">Cancel</v-btn>
        <v-btn :color="confirm === 'nap' ? stateColor('ASLEEP') : 'primary'" variant="flat" @click="act(confirm!)">{{ confirm === 'nap' ? 'Nap' : confirm === 'offboard' ? 'Offboard' : 'Wake' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <RenameDialog v-model="renameOpen" :name="title" @submit="rename" />
  <ScheduleDialog v-model="scheduleOpen" :schedule="status?.schedule" :name="title" :error="scheduleError" :saving="savingSchedule" @submit="saveSchedule" @clear="clearSchedule" />
  <TagsDialog v-model="tagsOpen" :tags="status?.tags" :name="title" @submit="setTags" />
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-hero__tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dm-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.dm-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.dm-layout__wide { grid-column: 1 / -1; }
@media (min-width: 1280px) { .dm-layout { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); } }
/* The requests while not awake: a column per kind, as many as the card's width holds (two in the narrow column). */
.dm-requests { display: grid; grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr)); gap: 16px 24px; padding: 4px 16px 16px; }

/* The hero: a sky that follows the state, the icon in its dashed orbit, the name, its chips, its week. */
.dm-hero { position: relative; overflow: hidden; }
.dm-hero__sky { position: absolute; inset: 0; pointer-events: none; transition: background 1.4s;
  background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-moon), 0.12), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.16), transparent 70%); }
.dm-hero__sky[data-mood="wake"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-sun), 0.2), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.14), transparent 70%); }
.dm-hero__sky[data-mood="load"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-primary), 0.24), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-sun), 0.12), transparent 70%); }
.dm-hero__sky[data-mood="failed"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-error), 0.18), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.12), transparent 70%); }
.dm-hero__body { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 28px; align-items: center; padding: 26px 28px; }
.dm-hero__icon { display: grid; place-items: center; width: 124px; height: 124px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.18); }
.dm-hero__main { min-width: 0; }
.dm-hero__where { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: -6px 0 2px -8px; font: 500 0.7rem/1.4 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; }
.dm-hero__back { margin-right: -2px; }
.dm-hero__sep { opacity: 0.4; }
.dm-hero__router { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); text-decoration: none; transition: color 0.2s; }
.dm-hero__router:hover { color: rgb(var(--v-theme-primary)); }
.dm-hero__router:focus-visible, .dm-hero__url:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-hero__region { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-hero__title { margin: 2px 0 12px; overflow-wrap: anywhere; }
.dm-hero__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.dm-hero__since { font-size: 0.9rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-hero__since strong { color: rgb(var(--v-theme-on-surface)); font-weight: 600; font-variant-numeric: tabular-nums; }
.dm-hero__url { display: inline-flex; align-items: center; min-width: 0; font-size: 0.9rem; color: rgb(var(--v-theme-primary)); text-decoration: none; overflow-wrap: anywhere; }
.dm-hero__url:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-hero__week { margin-top: 14px; max-width: 560px; }
.dm-hero__side { align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 16px; }
.dm-hero__actions { min-width: 132px; }

/* Lists and tables inside cards: on the glass. */
.dm-backend :deep(.v-list-item-title) { font-weight: 600; letter-spacing: -0.01em; }
.dm-backend :deep(.v-list-item-subtitle), .dm-wrap :deep(.v-list-item-subtitle) { display: block; -webkit-line-clamp: none; line-clamp: none; }
.dm-summary :deep(th) { width: 42%; font-size: 0.86rem !important; }
.dm-summary :deep(td) { font-variant-numeric: tabular-nums; }
.dm-summary :deep(td.mono) { font-size: 0.8rem; }

/* The costs area: three figures, then the energy its naps did not use. */
.dm-costs { margin: 4px 16px 16px; padding: 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 16px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-costs__figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.dm-figure { padding: 10px 14px; border-radius: 14px; background: rgba(var(--v-theme-on-surface), 0.035); }
.dm-figure__value { font-size: 1.45rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
.dm-figure__label { font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-energy { display: flex; align-items: flex-start; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: 14px;
  background: rgba(var(--v-theme-success), 0.07); border: 1px solid rgba(var(--v-theme-success), 0.2); }
.dm-energy__main { min-width: 0; }
.dm-energy__label { font: 500 0.68rem/1.4 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgb(var(--v-theme-success)); }
.dm-energy__values { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; margin-top: 2px; font-size: 0.95rem; font-variant-numeric: tabular-nums; }
.dm-energy__values strong { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.02em; }
.dm-energy__everyday { display: flex; flex-wrap: wrap; gap: 2px 16px; margin-top: 2px; }
.dm-energy__equiv { display: inline-flex; align-items: center; gap: 5px; font-size: 0.84rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-energy__note { margin-top: 2px; font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-costs__note { margin-top: 10px; font-size: 0.78rem; line-height: 1.45; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

/* Links in the text: the theme's, underlined when pointed at. */
.dm-links a, .dm-alert-links a { color: rgb(var(--v-theme-primary)); text-decoration: none; font-weight: 500; }
.dm-links a:hover, .dm-alert-links a:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-subhead { font: 500 0.66rem/1.4 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), 0.6); }
.dm-count-row__key { min-width: 0; overflow-wrap: anywhere; }
.dm-count-row + .dm-count-row { border-top: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-setting { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.02); transition: border-color 0.2s, background-color 0.2s; }
.dm-setting:hover { border-color: rgba(var(--v-theme-primary), 0.4); background: rgba(var(--v-theme-primary), 0.06); }
.dm-version { font: 500 0.72rem/1.4 var(--dm-mono); letter-spacing: 0.04em; }

@media (max-width: 960px) {
  .dm-hero__body { grid-template-columns: auto minmax(0, 1fr); gap: 18px 22px; padding: 22px; }
  .dm-hero__icon { width: 96px; height: 96px; }
  .dm-hero__icon :deep(svg) { width: 68px; height: 68px; }
  .dm-hero__side { grid-column: 1 / -1; flex-direction: row-reverse; align-items: center; }
}
/* Phones: the icon beside the name, the chips and the week under them at full width. */
@media (max-width: 600px) {
  .dm-hero__body { gap: 14px; padding: 18px 16px; }
  .dm-hero__main { display: contents; }
  .dm-hero__head { min-width: 0; }
  .dm-hero__info { grid-column: 1 / -1; }
  .dm-hero__icon { width: 60px; height: 60px; }
  .dm-hero__icon :deep(svg) { width: 44px; height: 44px; }
  .dm-hero__where { letter-spacing: 0.08em; gap: 2px 6px; }
  .dm-hero__title { font-size: 1.6rem !important; margin-bottom: 0; }
  .dm-hero__week { margin-top: 12px; }
  .dm-costs { margin: 4px 12px 12px; padding: 12px; }
}
</style>
