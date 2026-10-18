<script setup lang="ts">
// The manager's IP lists (R6b): downloaded once for every router by its list function, read by the routers from S3.
import { onMounted, ref } from 'vue';
import { mdiShieldSearch } from '@mdi/js';
import { api } from '../api';
import { listSourceHref, relative } from '../format';
import { useNow } from '../now';
import DmLogo from './DmLogo.vue';
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
// The status dot's color: the same reading as the text beside it.
const tone = (l: IpListRow) => (l.error ? 'warning' : l.version ? 'success' : 'none');
const headers = [
  { title: 'List', key: 'name' }, { title: 'Action', key: 'action' }, { title: 'Entries', key: 'entries', align: 'end' as const },
  { title: 'Last download', key: 'fetchedAt' }, { title: 'Status', key: 'status', sortable: false },
];
</script>

<template>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-6" :text="`IP lists: ${error}`" />
  <v-card v-else-if="info?.catalog" id="ip-lists" class="dm-iplists mt-6">
    <v-card-item class="dm-iplists__head">
      <template #prepend>
        <v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiShieldSearch" size="19" /></v-avatar>
      </template>
      <v-card-title>IP lists</v-card-title>
    </v-card-item>
    <v-card-text class="dm-iplists__lead text-body-medium text-medium-emphasis pb-2">
      Lists of addresses that seldom belong to a visitor (scanners, cloud providers, known abusers), the manager's own: every router of the
      organization reads them. <strong>defer</strong>: a request from a listed address does not wake a workload by itself (in a browser, the
      waiting page's script still wakes it); <strong>ignore</strong>: it never wakes one. Set them with <code>ip_lists</code> in the manager's
      Terraform; a router written in Terraform can add lists of its own (its view shows them).
    </v-card-text>
    <v-data-table v-if="info.lists.length" :headers="headers" :items="info.lists" item-value="name" density="compact" hide-default-footer :items-per-page="-1" class="dm-iplists__table">
      <template #[`item.name`]="{ item }">
        <a v-if="listSourceHref(item.url)" :href="listSourceHref(item.url) ?? undefined" target="_blank" rel="noopener" class="dm-iplists__name">{{ item.name }}</a><span v-else class="dm-iplists__name">{{ item.name }}</span>
      </template>
      <template #[`item.action`]="{ item }">
        <span class="dm-iplists__action" :class="`dm-iplists__action--${item.action}`">{{ item.action }}</span>
      </template>
      <template #[`item.entries`]="{ item }"><span class="dm-num">{{ item.entries === undefined ? '—' : item.entries.toLocaleString('en-US') }}</span></template>
      <template #[`item.fetchedAt`]="{ item }"><span class="nowrap dm-num">{{ relative(item.fetchedAt, now) }}</span></template>
      <template #[`item.status`]="{ item }">
        <span class="dm-iplists__status" :class="{ 'text-warning': item.error }"><span class="dm-iplists__dot" :class="`dm-iplists__dot--${tone(item)}`" aria-hidden="true" />{{ status(item) }}</span>
      </template>
    </v-data-table>
    <v-card-text v-else class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No list: set ip_lists in the manager's Terraform.</span>
    </v-card-text>
    <v-card-text class="text-body-small text-medium-emphasis pt-2">
      Downloaded once for every router by the manager (checked every hour, each list at its refresh period); a version that
      lost more than half its entries is refused. Routers read them from S3 within 5 minutes.
    </v-card-text>
  </v-card>
</template>

<style scoped>
.dm-iplists__head { padding: 16px 16px 4px !important; }
.dm-iplists__head .v-card-title { padding-top: 0 !important; }
.dm-iplists__lead { max-width: 72rem; text-wrap: pretty; }
.dm-iplists__lead strong { color: rgb(var(--v-theme-on-surface)); font-weight: 600; }
.dm-iplists__name { font-weight: 500; }
a.dm-iplists__name { color: rgb(var(--v-theme-primary)); text-decoration: none; }
a.dm-iplists__name:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-iplists__action { display: inline-block; padding: 3px 8px; border-radius: 6px; font: 500 0.7rem/1.2 var(--dm-mono); letter-spacing: 0.06em; text-transform: uppercase;
  color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), 0.1); }
.dm-iplists__action--ignore { color: rgb(var(--v-theme-secondary)); background: rgba(var(--v-theme-secondary), 0.1); }
.dm-iplists__status { display: inline-flex; align-items: center; gap: 8px; }
.dm-iplists__dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgba(var(--v-theme-on-surface), 0.3); }
.dm-iplists__dot--success { background: rgb(var(--v-theme-success)); box-shadow: 0 0 0 3px rgba(var(--v-theme-success), 0.16); }
.dm-iplists__dot--warning { background: rgb(var(--v-theme-warning)); box-shadow: 0 0 0 3px rgba(var(--v-theme-warning), 0.16); }
.dm-num { font-variant-numeric: tabular-nums; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding-block: 24px !important; }
</style>
