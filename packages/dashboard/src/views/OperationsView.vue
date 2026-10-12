<script setup lang="ts">
// Operations (onboarding, R4b): onboardings, offboardings and router installations run by the workflow, with their steps.
import { computed, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { api } from '../api';
import { relative } from '../format';
import { useNow } from '../now';
import { operationProgress, operationTitle, stepColor } from '../operations';
import { usePoll } from '../poll';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import type { Operation } from '../types';

const now = useNow();
const { smAndDown } = useDisplay();
const operations = ref<Operation[]>([]);
const expanded = ref<string[]>([]);
const { error, loading, nextAt, run } = usePoll(async () => {
  operations.value = (await api<{ operations: Operation[] }>('/operations')).operations;
});
const running = computed(() => operations.value.filter((o) => o.status === 'running').length);
const statusColor = (s: Operation['status']) => ({ running: 'primary', succeeded: 'success', failed: 'error' })[s];
const headers = [
  { title: 'Operation', key: 'type', sortable: false },
  { title: 'Status', key: 'status' },
  { title: 'Progress', key: 'progress', sortable: false },
  { title: 'By', key: 'by' },
  { title: 'Started', key: 'createdAt' },
  { title: '', key: 'data-table-expand' },
];
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-2">
    <h1 class="text-headline-small">Operations</h1>
    <v-chip v-if="running" color="primary" variant="tonal" label>{{ running }} running</v-chip>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <p class="text-medium-emphasis mb-4">Onboardings, offboardings and router installations, run step by step in the target account and region by
    AWS API calls. A step waits for a lock, a slot or a resource being created; a failed onboarding is undone.</p>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card>
    <v-data-table v-model:expanded="expanded" :mobile="smAndDown" :headers="headers" :items="operations" :loading="loading && !operations.length" item-value="id" show-expand :items-per-page="25">
      <template #[`item.type`]="{ item }">
        <div class="font-weight-medium">{{ operationTitle(item) }}</div>
        <div class="text-body-small text-medium-emphasis mono">{{ item.id }}</div>
      </template>
      <template #[`item.status`]="{ item }"><v-chip :color="statusColor(item.status)" variant="tonal" label>{{ item.status }}</v-chip></template>
      <template #[`item.progress`]="{ item }">
        <div class="d-flex align-center ga-2" style="min-width: 160px">
          <v-progress-linear :model-value="(100 * operationProgress(item).done) / operationProgress(item).total" :color="statusColor(item.status)" height="6" rounded style="max-width: 80px" />
          <span class="nowrap">{{ operationProgress(item).done }}/{{ operationProgress(item).total }}</span>
        </div>
        <div v-if="operationProgress(item).current" class="text-body-small text-medium-emphasis">{{ operationProgress(item).current }}</div>
        <div v-if="item.error" class="text-body-small text-error">{{ item.error }}</div>
      </template>
      <template #[`item.createdAt`]="{ item }"><span class="nowrap">{{ relative(item.createdAt, now) }}</span></template>
      <template #expanded-row="{ columns, item }">
        <tr>
          <td :colspan="columns.length" class="pa-4">
            <div v-for="step in item.steps" :key="step.name" class="d-flex align-center ga-2 py-1 text-body-medium">
              <v-chip :color="stepColor(step.status)" size="small" variant="tonal" label style="min-width: 76px">{{ step.status }}</v-chip>
              <span class="font-weight-medium">{{ step.name }}</span>
              <span v-if="step.detail" class="text-medium-emphasis">{{ step.detail }}</span>
              <span v-if="(step.attempts ?? 0) > 1" class="text-body-small text-medium-emphasis">({{ step.attempts }} attempts)</span>
            </div>
          </td>
        </tr>
      </template>
    </v-data-table>
  </v-card>
</template>
