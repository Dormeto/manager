<script setup lang="ts">
// The manager's IP lists (R6b): downloaded once for every router by its list function, read by the routers from S3.
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { listSourceHref, relative } from '../format';
import { useNow } from '../now';
import type { IpListRow, IpListsInfo } from '../types';

const now = useNow();
const info = ref<IpListsInfo | null>(null);
const error = ref('');
onMounted(async () => {
  try {
    info.value = await api<IpListsInfo>('/ip-lists');
  } catch (err) {
    error.value = (err as Error).message;
  }
});
const status = (l: IpListRow) => (l.error ? `${l.version ? 'last download failed' : 'never downloaded'}: ${l.error}` : l.version ? 'ok' : 'not downloaded yet');
const headers = [
  { title: 'List', key: 'name' }, { title: 'Action', key: 'action' }, { title: 'Entries', key: 'entries', align: 'end' as const },
  { title: 'Last download', key: 'fetchedAt' }, { title: 'Status', key: 'status', sortable: false },
];
</script>

<template>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" :text="`IP lists: ${error}`" />
  <v-card v-else-if="info?.catalog" id="ip-lists" title="IP lists" class="mt-4">
    <v-data-table v-if="info.lists.length" :headers="headers" :items="info.lists" item-value="name" density="compact" hide-default-footer :items-per-page="-1">
      <template #[`item.name`]="{ item }">
        <a v-if="listSourceHref(item.url)" :href="listSourceHref(item.url) ?? undefined" target="_blank" rel="noopener">{{ item.name }}</a><span v-else>{{ item.name }}</span>
      </template>
      <template #[`item.entries`]="{ item }">{{ item.entries === undefined ? '—' : item.entries.toLocaleString('en-US') }}</template>
      <template #[`item.fetchedAt`]="{ item }"><span class="nowrap">{{ relative(item.fetchedAt, now) }}</span></template>
      <template #[`item.status`]="{ item }">
        <span :class="{ 'text-warning': item.error }">{{ status(item) }}</span>
      </template>
    </v-data-table>
    <v-card-text v-else class="text-medium-emphasis">No list: set ip_lists in the manager's Terraform.</v-card-text>
    <v-card-text class="text-body-small text-medium-emphasis pt-0">
      Downloaded once for every router by the manager (checked every hour, each list at its refresh period); a version that
      lost more than half its entries is refused. Routers read them from S3 within 5 minutes.
    </v-card-text>
  </v-card>
</template>
