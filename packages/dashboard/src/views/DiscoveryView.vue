<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { computed, onMounted, ref, watch } from 'vue';
import { mdiRefresh } from '@mdi/js';
import { api } from '../api';
import { backendLabel, percent, relative, shortId } from '../format';
import type { Candidate, RouterInfo } from '../types';

const now = useNow();
const { smAndDown } = useDisplay();
const routers = ref<RouterInfo[]>([]);
const router = ref<string | null>(null);
const candidates = ref<Candidate[]>([]);
const generatedAt = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const shown = ref<string[]>(['managed', 'eligible', 'ineligible']);

async function discover() {
  if (!router.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await api<{ generatedAt: string; candidates: Candidate[] }>(`/discovery/${encodeURIComponent(router.value)}`);
    candidates.value = result.candidates;
    generatedAt.value = result.generatedAt;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    routers.value = (await api<{ routers: RouterInfo[] }>('/routers')).routers;
    router.value = routers.value[0]?.name ?? null;
  } catch (err) {
    error.value = (err as Error).message;
  }
});
watch(router, discover);

const visible = computed(() => candidates.value.filter((c) => shown.value.includes(c.status)));
const counts = computed(() => Object.fromEntries(['managed', 'eligible', 'ineligible'].map((s) => [s, candidates.value.filter((c) => c.status === s).length])));
const COLORS: Record<string, string> = { managed: 'success', eligible: 'primary', ineligible: 'grey' };
const headers = [
  { title: 'Status', key: 'status' },
  { title: 'Rule', key: 'conditions', sortable: false },
  { title: 'Listener', key: 'listener' },
  { title: 'Target group', key: 'targetGroup' },
  { title: 'Backend', key: 'backend', sortable: false },
  { title: 'Idle (7 days)', key: 'idleHours7d', align: 'end' as const },
  { title: 'Requests (7 days)', key: 'requests7d', align: 'end' as const },
  { title: 'Workload or reason', key: 'detail', sortable: false },
];
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-2">
    <h1 class="text-headline-small">Discovery</h1>
    <v-spacer />
    <v-select v-model="router" :items="routers.map((r) => r.name)" label="Router" density="compact" hide-details style="max-width: 220px" />
    <v-btn :prepend-icon="mdiRefresh" variant="tonal" :loading="loading" :disabled="!router" @click="discover">Run</v-btn>
  </div>
  <p class="text-medium-emphasis mb-4">Load balancer rules of the router's region. An eligible rule is onboarded with the router's
    Terraform <code>workload</code> module; idle hours are the hours without any request over the last 7 days.</p>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-chip-group v-model="shown" multiple class="mb-2">
    <v-chip v-for="s in ['managed', 'eligible', 'ineligible']" :key="s" :value="s" :color="COLORS[s]" filter variant="tonal">{{ s }} ({{ counts[s] ?? 0 }})</v-chip>
  </v-chip-group>
  <v-card>
    <v-data-table :mobile="smAndDown" :headers="headers" :items="visible" :loading="loading" item-value="ruleArn" :items-per-page="50">
      <template #[`item.status`]="{ item }"><v-chip :color="COLORS[item.status]" variant="tonal" label>{{ item.status }}</v-chip></template>
      <template #[`item.conditions`]="{ item }">
        <div class="font-weight-medium">{{ item.conditions }}</div>
        <div class="text-body-small text-medium-emphasis">{{ item.loadBalancer }} · priority {{ item.priority }}</div>
      </template>
      <template #[`item.backend`]="{ item }">
        <span v-if="item.backend">{{ backendLabel(item.backend.kind) }} <span class="mono">{{ shortId(item.backend.id) }}</span></span>
      </template>
      <template #[`item.idleHours7d`]="{ item }">
        <div v-if="item.idleHours7d !== null" class="d-flex align-center justify-end ga-2" style="min-width: 120px">
          <v-progress-linear :model-value="(100 * item.idleHours7d) / 168" color="info" height="6" rounded style="max-width: 70px" />
          <span class="nowrap">{{ percent(item.idleHours7d, 168) }}</span>
        </div>
      </template>
      <template #[`item.requests7d`]="{ item }">{{ item.requests7d?.toLocaleString() ?? '' }}</template>
      <template #[`item.detail`]="{ item }">
        <router-link v-if="item.status === 'managed'" :to="`/workloads/${router}/${item.workloadId}`">{{ item.workloadId }}</router-link>
        <span v-else-if="item.status === 'eligible'" class="text-medium-emphasis">suggested id <span class="mono">{{ item.suggestedId }}</span></span>
        <span v-else class="text-medium-emphasis">{{ item.reason }}</span>
      </template>
    </v-data-table>
  </v-card>
  <p v-if="generatedAt" class="text-body-small text-medium-emphasis mt-2">Discovered {{ relative(generatedAt, now) }}.</p>
</template>
