<script setup lang="ts">
import { useNow } from '../now';
import { computed, ref } from 'vue';
import { mdiArrowLeft, mdiInformationOutline, mdiOpenInNew, mdiPowerSleep, mdiWeatherSunny } from '@mdi/js';
import { settingRows } from '../settings';
import { api } from '../api';
import { usePoll } from '../poll';
import { backendLabel, duration, relative, ruleText, shortId, stateColor } from '../format';
import { useSession } from '../stores/session';
import StateChip from '../components/StateChip.vue';
import type { Counts, WorkloadStatus, WorkloadSummary } from '../types';

const now = useNow();
const props = defineProps<{ router: string; id: string }>();
const session = useSession();
const status = ref<WorkloadStatus | null>(null);
const url = ref<string | null>(null);
const confirm = ref<'nap' | 'wake' | null>(null);
const acting = ref(false);
const notice = ref<{ type: 'success' | 'error'; text: string } | null>(null);
const path = computed(() => `/workloads/${encodeURIComponent(props.router)}/${encodeURIComponent(props.id)}`);

const { error, loading, refreshedAt, run } = usePoll(async () => {
  status.value = await api<WorkloadStatus>(path.value);
  if (url.value === null) {
    const list = await api<{ workloads: WorkloadSummary[] }>('/workloads');
    url.value = list.workloads.find((w) => w.router === props.router && w.workloadId === props.id)?.url ?? '';
  }
}, 10_000);

async function act(action: 'nap' | 'wake') {
  confirm.value = null;
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
const summary = computed(() => {
  const s = status.value;
  if (!s) return [];
  return [
    { label: 'Route', value: s.route === 'app' ? 'application' : s.route },
    { label: 'Nap', value: s.nap ? (s.nap.inSeconds > 0 ? `eligible in ${duration(s.nap.inSeconds)}` : 'due at the next idle check (every 5 min)') : '—' },
    { label: 'Last request', value: relative(s.lastRequestAt, now.value) },
    { label: 'Awake since', value: relative(s.awakeSince, now.value) },
    { label: 'Last state change', value: relative(s.updatedAt, now.value) },
    { label: 'Wakes', value: String(s.wakeCount) },
    { label: 'Held requests', value: String(s.holders) },
    { label: 'Pending wake', value: s.pendingWake ? 'yes' : 'no' },
  ];
});
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-3 mb-4">
    <v-btn :icon="mdiArrowLeft" variant="text" to="/workloads" aria-label="Back to the workloads" />
    <h1 class="text-headline-small">{{ id }}</h1>
    <StateChip v-if="status" :state="status.state" />
    <span class="text-medium-emphasis">{{ router }}</span>
    <a v-if="url" :href="url" target="_blank" rel="noopener">{{ url.replace('https://', '').replace(/\/$/, '') }}<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
    <v-spacer />
    <template v-if="session.canOperate && status">
      <v-btn :prepend-icon="mdiPowerSleep" variant="tonal" :disabled="status.state !== 'AWAKE' || acting" @click="confirm = 'nap'">Nap</v-btn>
      <v-btn :prepend-icon="mdiWeatherSunny" color="primary" :disabled="!['ASLEEP', 'FAILED', 'NAPPING'].includes(status.state) || acting" @click="confirm = 'wake'">Wake</v-btn>
    </template>
  </div>
  <v-alert v-if="notice" :type="notice.type" closable class="mb-4" :text="notice.text" @click:close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
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
          <v-list-item v-for="b in status.backends" :key="b.id" :title="shortId(b.id)" :subtitle="backendLabel(b.kind) + (b.companion ? ' · companion' : '')">
            <template #append>
              <div class="d-flex align-center ga-2">
                <span v-if="b.kind === 'asg'" class="text-body-small text-medium-emphasis">min {{ b.min }} · desired {{ b.desired }} · max {{ b.max }}<template v-if="b.warmPool"> · warm pool {{ b.warmPool.state }} ({{ b.warmPool.size }})</template></span>
                <v-chip :color="b.status === 'running' ? 'success' : b.status === 'stopped' ? 'info' : 'warning'" variant="tonal" label>{{ b.status }}</v-chip>
              </div>
            </template>
          </v-list-item>
        </v-list>
        <v-card-text v-if="status.ignoredTargets.length" class="pt-0 text-body-small">Ignored: {{ status.ignoredTargets.map((t) => `${t.id} (${t.reason})`).join(', ') }}</v-card-text>
      </v-card>
      <v-card title="Targets">
        <v-card-text>
          <span v-if="!status.targets.length" class="text-medium-emphasis">No registered target.</span>
          <v-chip v-for="t in status.targets" :key="t.id" class="mr-2 mb-2" :color="t.state === 'healthy' ? 'success' : 'warning'" variant="tonal" label>
            <span class="mono">{{ t.id }}</span>&nbsp;{{ t.state }}
          </v-chip>
        </v-card-text>
      </v-card>
    </v-col>

    <v-col v-if="status.recommendations.length" cols="12">
      <v-alert v-for="r in status.recommendations" :key="r.backend" type="info" variant="tonal" :title="`Recommendation for ${shortId(r.backend)}`" :text="r.message" />
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
            <div class="text-body-small text-medium-emphasis mb-1">Public lists of scanner and cloud networks, set on the router and applied to all its workloads; the router downloads them every day.</div>
            <div v-for="l in status.ipLists" :key="l.name" class="text-body-medium">
              <a v-if="l.url" :href="l.url" target="_blank" rel="noopener" :title="l.url">{{ l.name }}</a><span v-else>{{ l.name }}</span>
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
          <span class="text-medium-emphasis">Router {{ status.router.version }} ({{ status.router.build }})<template v-if="refreshedAt"> · refreshed {{ relative(new Date(refreshedAt).toISOString(), now) }}</template></span>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>

  <v-dialog :model-value="confirm !== null" max-width="460" @update:model-value="confirm = null">
    <v-card :title="confirm === 'nap' ? `Nap ${id}?` : `Wake ${id}?`">
      <v-card-text>{{ confirm === 'nap'
        ? 'The route switches to the waker and the backends stop after the drain. The next request wakes the workload again.'
        : 'The backends start now; the route switches back to the application once a target is healthy.' }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="confirm = null">Cancel</v-btn>
        <v-btn :color="confirm === 'nap' ? stateColor('ASLEEP') : 'primary'" variant="flat" @click="act(confirm!)">{{ confirm === 'nap' ? 'Nap' : 'Wake' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
