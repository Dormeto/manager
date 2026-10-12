<script setup lang="ts">
// Organization discovery: the last run (scanned, skipped and failed account-regions, lint) and the candidate rules.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiCogOutline, mdiEyeOffOutline, mdiEyeOutline, mdiPlay } from '@mdi/js';
import type { Candidate, RunRecord, Status } from '@dormeto/discovery/types';
import { api } from '../api';
import LintAlert from '../components/LintAlert.vue';
import { STATUSES, idleShare, statusColor, statusHelp, statusLabel, targetText } from '../discovery';
import { backendLabel, relative, shortId } from '../format';
import { backendIcon } from '../icons';
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
let poll: number | undefined;

async function load() {
  loading.value = true;
  try {
    const result = await api<{ lastRun: RunRecord | null; candidates: Candidate[] }>('/discovery');
    lastRun.value = result.lastRun;
    candidates.value = result.candidates;
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

onMounted(load);
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
      <v-tooltip v-for="s in STATUSES" :key="s" :text="statusHelp(s)" location="top" max-width="300">
        <template #activator="{ props }">
          <v-chip v-bind="props" :value="s" :color="statusColor(s)" filter variant="tonal">{{ statusLabel(s) }} ({{ counts[s] }})</v-chip>
        </template>
      </v-tooltip>
    </v-chip-group>
    <v-spacer />
    <template v-if="session.canOperate && selected.length">
      <v-btn v-if="selectedDismissed" :prepend-icon="mdiEyeOutline" variant="tonal" @click="changeDismissal('restore')">Restore ({{ selected.length }})</v-btn>
      <v-btn v-else :prepend-icon="mdiEyeOffOutline" variant="tonal" @click="dismissDialog = true">Dismiss ({{ selected.length }})</v-btn>
    </template>
  </div>

  <v-card>
    <v-data-table v-model="selected" :mobile="smAndDown" :headers="headers" :items="visible" :loading="loading" item-value="id"
      :show-select="session.canOperate" :items-per-page="50">
      <template #[`item.status`]="{ item }"><v-chip :color="statusColor(item.status)" variant="tonal" label>{{ statusLabel(item.status) }}</v-chip></template>
      <template #[`item.account`]="{ item }">
        <div>{{ item.accountName }}</div>
        <div class="text-body-small text-medium-emphasis mono">{{ item.account }}</div>
      </template>
      <template #[`item.conditions`]="{ item }">
        <div class="font-weight-medium">{{ item.conditions }}</div>
        <div class="text-body-small text-medium-emphasis">{{ item.loadBalancer }} · {{ item.listener }} · priority {{ item.priority }}</div>
      </template>
      <template #[`item.backend`]="{ item }">
        <span v-if="item.backend" class="d-inline-flex align-center ga-2">
          <img v-if="backendIcon(item.backend.kind)" :src="backendIcon(item.backend.kind)!" alt="" width="22" height="22" class="backend-icon">
          <span>{{ backendLabel(item.backend.kind) }} <span class="mono">{{ shortId(item.backend.id) }}</span></span>
        </span>
        <span v-else-if="item.workloadId" class="text-medium-emphasis">workload <span class="mono">{{ item.workloadId }}</span></span>
      </template>
      <template #[`item.idleHours7d`]="{ item }">
        <div v-if="item.idleHours7d !== null" class="d-flex align-center justify-end ga-2" style="min-width: 120px">
          <v-progress-linear :model-value="(100 * item.idleHours7d) / 168" color="info" height="6" rounded style="max-width: 70px" />
          <span class="nowrap">{{ idleShare(item) }}</span>
        </div>
      </template>
      <template #[`item.statusReason`]="{ item }">
        <span class="text-medium-emphasis">{{ item.statusReason }}</span>
        <div v-if="item.status === 'pending-onboarding' && item.suggestedId" class="text-body-small text-medium-emphasis">suggested id <span class="mono">{{ item.suggestedId }}</span></div>
      </template>
      <template #[`item.firstSeenAt`]="{ item }"><span class="nowrap">{{ relative(item.firstSeenAt, now) }}</span></template>
    </v-data-table>
  </v-card>

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
