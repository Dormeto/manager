<script setup lang="ts">
import { useNow } from '../now';
import { computed, ref } from 'vue';
import { mdiArrowLeft, mdiCancel, mdiChevronDown, mdiInformationOutline, mdiPencilOutline, mdiLogoutVariant, mdiOpenInNew, mdiPause, mdiPlay, mdiPowerSleep, mdiWeatherSunny } from '@mdi/js';
import { settingRows } from '../settings';
import { backendIcon } from '../icons';
import { api } from '../api';
import { usePoll } from '../poll';
import { backendArn, backendLabel, backendService, duration, listSourceHref, targetInfo, usd, usdHourly, relative, routeColor, routeLabel, ruleText, shortId, stateColor } from '../format';
import { useSession } from '../stores/session';
import { pauseLine, type TargetOption } from '../pause';
import ExcludeDialog from '../components/ExcludeDialog.vue';
import PauseChip from '../components/PauseChip.vue';
import PauseDialog from '../components/PauseDialog.vue';
import ResourceTooltip from '../components/ResourceTooltip.vue';
import RenameDialog from '../components/RenameDialog.vue';
import NoticeAlert, { type Notice } from '../components/NoticeAlert.vue';
import StateBar from '../components/StateBar.vue';
import StateChip from '../components/StateChip.vue';
import HistoryCard from '../components/HistoryCard.vue';
import IdleWindowCard from '../components/IdleWindowCard.vue';
import { stateSince } from '../state';
import { backendCost, barSavings, discountText } from '../costs';
import type { Backend } from '../types';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import { failureTitle } from '../failures';
import type { Counts, WorkloadStatus } from '../types';

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
  return `AWS list prices of what its last nap stopped, Spot at Spot prices${d ? `, after discounts (${discountText(d)})` : ''}; a month is 730 hours.`;
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
</script>

<template>
  <div data-test="header" class="d-flex flex-wrap align-center ga-3 mb-4">
    <v-btn :icon="mdiArrowLeft" variant="text" to="/workloads" aria-label="Back to the workloads" />
    <h1 class="text-headline-small">{{ title }}</h1>
    <StateChip v-if="status" :state="status.state" :failure="status.failure" />
    <StateBar v-if="status" :states="status.states7d" :idle-hours7d="status.idleHours7d" :requests7d="status.requests7d" :savings="barSavings(status.costs)" :width="140" />
    <PauseChip :pauses="pauses" />
    <router-link :to="`/routers/${encodeURIComponent(router)}`" class="text-medium-emphasis">{{ router }}</router-link>
    <a v-if="url" :href="url" target="_blank" rel="noopener">{{ url.replace('https://', '').replace(/\/$/, '') }}<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    <!-- Its actions in one menu (user request): wake and nap when its state allows, pause or resume, rename and offboard what
         the manager onboarded (offboard also a workload of a router it did not install), exclude its target group. -->
    <v-menu v-if="session.canOperate && status" location="bottom end">
      <template #activator="{ props: menu }">
        <v-btn v-bind="menu" data-test="actions" variant="tonal" :append-icon="mdiChevronDown" :disabled="acting">Actions</v-btn>
      </template>
      <v-list density="compact" min-width="200">
        <v-list-item data-test="action" :prepend-icon="mdiWeatherSunny" title="Wake" :disabled="!['ASLEEP', 'FAILED', 'NAPPING'].includes(status.state)" @click="confirm = 'wake'" />
        <v-list-item data-test="action" :prepend-icon="mdiPowerSleep" title="Nap" :disabled="status.state !== 'AWAKE' || pauses.length > 0" @click="confirm = 'nap'" />
        <v-list-item v-if="ownPause" data-test="action" :prepend-icon="mdiPlay" title="Resume" @click="change('resume')" />
        <v-list-item v-else data-test="action" :prepend-icon="mdiPause" title="Pause" @click="pauseOpen = true" />
        <v-list-item v-if="status.source === 'manager'" data-test="action" :prepend-icon="mdiPencilOutline" title="Rename" @click="renameOpen = true" />
        <v-list-item v-if="!excluded && excludeOptions.length" data-test="action" :prepend-icon="mdiCancel" title="Exclude" @click="excludeOpen = true" />
        <template v-if="status.source !== 'terraform'">
          <v-divider class="my-1" />
          <v-list-item data-test="action" :prepend-icon="mdiLogoutVariant" title="Offboard" base-color="error" @click="confirm = 'offboard'" />
        </template>
      </v-list>
    </v-menu>
  </div>
  <NoticeAlert v-if="notice" :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-if="pauses.length" type="info" variant="tonal" class="mb-4" :title="excluded ? 'Excluded: never napped, waiting for offboarding' : 'Paused: never napped, requests still wake it'">
    <div v-for="p in pauses" :key="`${p.scope}/${p.exclusionId ?? ''}`" class="text-body-medium">
      {{ pauseLine(p, now) }}
      <router-link v-if="p.exclusionId" to="/discovery" class="ml-1">Lift the exclusion in Discovery</router-link>
      <router-link v-else-if="p.scope === 'router'" to="/routers" class="ml-1">Resume the router</router-link>
    </div>
  </v-alert>
  <v-alert v-if="status?.failure" data-test="failure" :type="status.state === 'FAILED' ? 'error' : 'warning'" variant="tonal" class="mb-4" :title="failureTitle(status.failure)">
    <div class="text-body-medium">{{ status.failure.message }}</div>
    <div class="text-body-small text-medium-emphasis mt-1">{{ failureDetail }}</div>
  </v-alert>
  <v-alert v-if="fallbackText" data-test="fallbacks" type="info" variant="tonal" class="mb-4" title="On fallback instance types">
    {{ fallbackText }}: AWS had no capacity for their own types at the last wake; the next nap gives them back.
  </v-alert>
  <v-progress-linear v-if="loading && !status" indeterminate color="primary" />

  <v-row v-if="status">
    <v-col cols="12" md="5">
      <v-card title="Summary">
        <v-table density="comfortable">
          <tbody>
            <tr v-for="row in summary" :key="row.label"><th class="text-medium-emphasis font-weight-regular">{{ row.label }}</th><td>{{ row.value }}</td></tr>
          </tbody>
        </v-table>
      </v-card>
    </v-col>
    <v-col cols="12" md="7">
      <v-card title="Backends" class="mb-4">
        <v-list density="comfortable">
          <ResourceTooltip v-for="b in status.backends" :id="b.id" :key="b.id" :arn="backendArn(b, where)" :service="backendService(b.kind)" :rows="costRows(b)"
            :note="costRows(b).some((r) => r.label === 'Base cost') ? costNote : null">
            <template #default="{ tip }">
              <v-list-item v-bind="tip" data-test="backend" :title="shortId(b.id)" :subtitle="backendLabel(b.kind) + (b.companion ? ' · companion' : '')">
                <template v-if="backendIcon(b.kind)" #prepend>
                  <img :src="backendIcon(b.kind)!" :alt="backendLabel(b.kind)" width="36" height="36" class="mr-3 backend-icon">
                </template>
                <template #append>
                  <div class="d-flex align-center ga-2">
                    <span v-if="b.kind === 'asg'" class="text-body-small text-medium-emphasis">min {{ b.min }} · desired {{ b.desired }} · max {{ b.max }}<template v-if="b.warmPool"> · warm pool {{ b.warmPool.state }} ({{ b.warmPool.size }})</template></span>
                    <v-chip :color="b.status === 'running' ? 'success' : b.status === 'stopped' ? 'info' : 'warning'" variant="tonal" label>{{ b.status }}</v-chip>
                  </div>
                </template>
              </v-list-item>
            </template>
          </ResourceTooltip>
        </v-list>
        <v-card-text v-if="status.ignoredTargets.length" class="pt-0 text-body-small">Ignored: {{ status.ignoredTargets.map((t) => `${t.id} (${t.reason})`).join(', ') }}</v-card-text>
      </v-card>
      <v-card v-if="status.rules?.length || status.issues?.length" :title="(status.rules?.length ?? 0) > 1 ? `Rules (${status.rules!.length}, found from the target group)` : 'Rule'" class="mb-4">
        <v-alert v-if="status.issues?.length" type="warning" variant="tonal" density="compact" class="mx-4 mt-2"
          title="Not napped: some rules cannot be switched">
          <div v-for="issue in status.issues" :key="issue" class="text-body-small">{{ issue }}</div>
          <div class="text-body-small mt-1">Add the waker target group and the <code>dormeto:workload</code> tag to these rules, or remove them.</div>
        </v-alert>
        <v-list density="compact" class="py-0">
          <v-list-item v-for="r in status.rules" :key="r.arn" :title="r.conditions" :subtitle="r.issue ?? `priority ${r.priority ?? '—'}`">
            <template #append>
              <v-chip v-if="r.issue" color="warning" variant="tonal" label size="small">not switched</v-chip>
              <v-chip v-else :color="routeColor(r.route)" variant="tonal" label size="small">{{ r.route === 'app' ? 'application' : r.route }}</v-chip>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
      <v-card v-if="status.drift?.length" title="Drift repaired" class="mb-4">
        <v-card-subtitle class="text-wrap">Infrastructure as code changed what onboarding added; the router put it back.</v-card-subtitle>
        <v-list density="compact" class="py-0">
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
    </v-col>

    <v-col v-if="status.recommendations.length" cols="12">
      <v-alert v-for="r in status.recommendations" :key="r.backend" type="info" variant="tonal" :title="`Recommendation for ${shortId(r.backend)}`" :text="r.message" />
    </v-col>

    <v-col cols="12">
      <HistoryCard :router="router" :id="id" :now="now" />
    </v-col>

    <v-col cols="12">
      <IdleWindowCard :router="router" :id="id" />
    </v-col>

    <v-col cols="12" md="7">
      <v-card :title="`Requests while not awake (today · ${stats?.days ?? 7} days)`">
        <v-card-text v-if="statsError" class="text-error">{{ statsError }}</v-card-text>
        <v-row v-else no-gutters>
          <v-col v-for="kind in (['ignored', 'deferred', 'wakes'] as const)" :key="kind" cols="12" sm="4" class="pa-2">
            <div class="text-title-small mb-1">{{ { ignored: 'Ignored', deferred: 'Deferred', wakes: 'Wakes by trigger' }[kind] }}</div>
            <div v-if="!rows(kind).length" class="text-medium-emphasis text-body-medium">none</div>
            <div v-for="row in rows(kind)" :key="row.key" class="d-flex text-body-medium py-1">
              <span class="flex-grow-1">{{ row.key }}</span><span class="nowrap">{{ row.today }} · <strong>{{ row.total }}</strong></span>
            </div>
          </v-col>
        </v-row>
      </v-card>
    </v-col>
    <v-col cols="12" md="5">
      <v-card title="Wake filtering">
        <v-card-text>
          <div class="mb-3"><strong>Mode:</strong> {{ status.wakeMode === 'browser' ? 'browser (only the waiter page probe, the x-dormeto-wake header or a wake rule wakes)' : 'any request that passes the filters wakes' }}</div>
          <div v-for="r in [...status.noWakeRules, ...status.wakeRules]" :key="`${r.level}/${r.name}`" class="mb-2 text-body-medium">
            <v-chip :color="r.level === 'wake' ? 'success' : 'secondary'" variant="tonal" label class="mr-2">{{ r.level === 'wake' ? 'wake' : `no-wake · ${r.level}` }}</v-chip>
            <strong>{{ r.name }}</strong>: <span :class="{ 'text-error': r.invalid }">{{ r.invalid ? `invalid, ${r.invalid}` : ruleText(r.conditions) }}</span>
          </div>
          <div v-if="status.ipLists.length" class="mt-3">
            <div class="text-title-small">IP reputation lists</div>
            <div class="text-body-small text-medium-emphasis mb-1">Lists of scanner and cloud networks, public or stored in S3, set on the router and applied to all its workloads; the router downloads them again daily by default.</div>
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
    </v-col>
    <v-col cols="12">
      <v-card title="Settings">
        <v-card-text class="d-flex flex-wrap ga-6 text-body-medium">
          <v-tooltip v-for="row in settingRows(status.settings)" :key="row.key" location="top" max-width="380" open-on-click open-on-focus>
            <template #activator="{ props }">
              <span v-bind="props" class="setting" tabindex="0" :aria-label="`${row.label} ${row.value}: ${row.help} ${row.range}`">
                {{ row.label }} <strong>{{ row.value }}</strong><v-icon :icon="mdiInformationOutline" size="x-small" class="ml-1 text-medium-emphasis" />
              </span>
            </template>
            <div class="text-body-medium">{{ row.help }}</div>
            <div class="text-body-small mt-2"><strong>Acceptable:</strong> {{ row.range }}</div>
          </v-tooltip>
          <v-spacer />
          <span class="text-medium-emphasis">Router {{ status.router.version }} ({{ status.router.build }})</span>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>

  <PauseDialog v-model="pauseOpen" :subject="title" @submit="change('pause', $event)" />
  <ExcludeDialog v-model="excludeOpen" :options="excludeOptions" @submit="exclude" />
  <v-dialog :model-value="confirm !== null" max-width="460" @update:model-value="confirm = null">
    <v-card :title="confirm === 'nap' ? `Nap ${title}?` : confirm === 'offboard' ? `Offboard ${title}?` : `Wake ${title}?`">
      <v-card-text>{{ confirm === 'nap'
        ? 'The route switches to the waker and the backends stop after the drain. The next request wakes the workload again.'
        : confirm === 'offboard'
          ? 'The workload is woken, then Dormeto removes what onboarding added: the waker from its rules, the waker target group, the tags. A workload written in Terraform is offboarded by removing its workload module.'
          : 'The backends start now; the route switches back to the application once a target is healthy.' }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="confirm = null">Cancel</v-btn>
        <v-btn :color="confirm === 'nap' ? stateColor('ASLEEP') : 'primary'" variant="flat" @click="act(confirm!)">{{ confirm === 'nap' ? 'Nap' : confirm === 'offboard' ? 'Offboard' : 'Wake' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <RenameDialog v-model="renameOpen" :name="title" @submit="rename" />
</template>
