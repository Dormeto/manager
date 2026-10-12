<script setup lang="ts">
import { useDisplay } from 'vuetify';
import { ref } from 'vue';
import { api } from '../api';
import { relative } from '../format';

interface Entry { id: string; at: string; who: string; role: string; action: string; target: string; result: string }

const { smAndDown } = useDisplay();
const entries = ref<Entry[]>([]);
const loading = ref(true);
const error = ref('');
api<{ entries: Entry[] }>('/audit')
  .then((r) => { entries.value = r.entries; })
  .catch((err: Error) => { error.value = err.message; })
  .finally(() => { loading.value = false; });

const headers = [
  { title: 'When', key: 'at' },
  { title: 'Who', key: 'who' },
  { title: 'Action', key: 'action' },
  { title: 'Target', key: 'target' },
  { title: 'Result', key: 'result' },
];
</script>

<template>
  <h1 class="text-headline-small mb-4">Audit</h1>
  <p class="text-medium-emphasis mb-4">Every action taken from the dashboard or the API, kept 90 days.</p>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card>
    <v-data-table :mobile="smAndDown" :headers="headers" :items="entries" :loading="loading" item-value="id" :items-per-page="50" :sort-by="[{ key: 'at', order: 'desc' }]">
      <template #[`item.at`]="{ item }"><span :title="item.at" class="nowrap">{{ relative(item.at) }}</span></template>
      <template #[`item.who`]="{ item }">{{ item.who }} <span class="text-body-small text-medium-emphasis">({{ item.role }})</span></template>
      <template #[`item.result`]="{ item }"><span :class="{ 'text-error': item.result.startsWith('error') }">{{ item.result }}</span></template>
    </v-data-table>
  </v-card>
</template>
