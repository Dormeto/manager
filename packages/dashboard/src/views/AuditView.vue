<script setup lang="ts">
import { useNow } from '../now';
import { ref } from 'vue';
import { mdiAlertCircleOutline, mdiCancel, mdiCheckCircleOutline } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import type { DmHeader } from '../table';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import DmTable from '../components/DmTable.vue';
import PageTitle from '../components/PageTitle.vue';
import StatusMark from '../components/StatusMark.vue';

interface Entry { id: string; at: string; who: string; role: string; action: string; target: string; result: string }

const now = useNow();
const entries = ref<Entry[]>([]);
const loading = ref(true);
const error = ref('');
api<{ entries: Entry[] }>('/audit')
  .then((r) => { entries.value = r.entries; })
  .catch((err: Error) => { error.value = err.message; })
  .finally(() => { loading.value = false; });

// Each column as its text (search, exports): the exact time, who with their role, the result as recorded.
const headers: DmHeader<Entry>[] = [
  { title: 'When', key: 'at' },
  { title: 'Who', key: 'who', text: (e) => `${e.who} (${e.role})` },
  { title: 'Action', key: 'action' },
  { title: 'Target', key: 'target' },
  { title: 'Result', key: 'result' },
];
// Cut on one line at these widths, the full text in a tooltip.
const CUT = { action: '14rem', target: '24rem' } as const;

// Presentation: the exact time behind the relative one, the initials on the brand's blue (as the navigation's).
const exact = (iso: string) => new Date(iso).toLocaleString('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
const initials = (email: string) => (email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
// A result's outcome as an icon (tables design §3), its word the icon's name: an error, a refusal, or done ("ok", or what
// was done). Beside it what the result says besides that word: an error's message, what a write changed.
type Outcome = 'error' | 'refused' | 'ok';
const outcome = (e: Entry): Outcome => (e.result.startsWith('error') ? 'error' : e.result === 'refused' ? 'refused' : 'ok');
const MARKS: Record<Outcome, { icon: string; color: string }> = {
  ok: { icon: mdiCheckCircleOutline, color: 'success' }, refused: { icon: mdiCancel, color: 'warning' }, error: { icon: mdiAlertCircleOutline, color: 'error' },
};
const detail = (e: Entry) => (outcome(e) === 'error' ? e.result.replace(/^error:?\s*/, '') : e.result === 'ok' || e.result === 'refused' ? '' : e.result);
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-4">
    <div>
      <PageTitle eyebrow="Administration" title="Audit" />
      <p class="text-medium-emphasis mt-1 mb-0">Every action taken from the dashboard or the API, kept 90 days.</p>
    </div>
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card class="dm-audit">
    <DmTable :headers="headers" :items="entries" :loading="loading" item-value="id" :sort-by="[{ key: 'at', order: 'desc' }]" :exported="{ name: 'audit', title: 'Audit' }">
      <template v-if="!entries.length" #loading><DmLoader label="Reading the audit trail…" :size="48" /></template>
      <template #no-data>
        <div class="dm-calm"><DmLogo state="sleep" :size="40" /><span class="text-medium-emphasis">No action recorded in the last 90 days.</span></div>
      </template>
      <template #[`item.at`]="{ item }">
        <v-tooltip location="top" :text="exact(item.at)">
          <template #activator="{ props }"><time v-bind="props" :datetime="item.at" class="dm-when nowrap">{{ relative(item.at, now) }}</time></template>
        </v-tooltip>
      </template>
      <template #[`item.who`]="{ item }">
        <div class="dm-who">
          <v-avatar size="28" class="dm-avatar">{{ initials(item.who) }}</v-avatar>
          <div class="dm-who__text">
            <div class="dm-who__email">{{ item.who }}</div>
            <div class="dm-who__role">{{ item.role }}</div>
          </div>
        </div>
      </template>
      <template v-for="(width, key) in CUT" :key="key" #[`item.${key}`]="{ item }">
        <v-tooltip location="top" max-width="600" open-on-focus>
          <template #activator="{ props }"><span v-bind="props" data-test="audit-cell" class="audit-cell text-truncate" :class="key === 'target' ? 'mono audit-cell--target' : 'audit-cell--action'" :style="{ maxWidth: key === 'target' ? `min(${width}, 22vw)` : width }" tabindex="0">{{ item[key] }}</span></template>
          <span class="audit-tip" :class="{ mono: key === 'target' }">{{ item[key] }}</span>
        </v-tooltip>
      </template>
      <template #[`item.result`]="{ item }">
        <!-- The outcome's icon; an error's message beside it whole, in red, wrapping and selectable (a chip's text is not), as before the redesign. -->
        <div data-test="audit-result" class="dm-result" :class="{ 'dm-result--error text-error': outcome(item) === 'error' }">
          <StatusMark :icon="MARKS[outcome(item)].icon" :color="MARKS[outcome(item)].color" :label="outcome(item)" :size="16" class="dm-result__icon">
            <div v-if="outcome(item) === 'error'" class="dm-result__tip">{{ detail(item) }}</div>
          </StatusMark>
          <span v-if="detail(item)" class="dm-result__text">{{ detail(item) }}</span>
        </div>
      </template>
    </DmTable>
  </v-card>
</template>

<style scoped>
.audit-cell { display: inline-block; vertical-align: bottom; border-radius: 4px; }
.audit-cell:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.audit-cell--action { font-weight: 500; }
.audit-cell--target { opacity: 0.85; }
.audit-tip { overflow-wrap: anywhere; }
.dm-when { font-variant-numeric: tabular-nums; color: rgba(var(--v-theme-on-surface), 0.72); cursor: default; }
.dm-who { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 6px 0; }
.dm-who__text { min-width: 0; }
.dm-who__email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.875rem; }
.dm-who__role { font: 500 0.6rem/1.5 var(--dm-mono); letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
.dm-avatar { flex: none; background: linear-gradient(155deg, rgb(69, 137, 202), rgb(3, 75, 128)); color: rgb(255, 255, 255); font-size: 0.66rem; font-weight: 600; }
.dm-result { display: flex; align-items: flex-start; gap: 8px; max-width: 36rem; padding: 6px 0; font-size: 0.875rem; line-height: 1.45; white-space: normal;
  overflow-wrap: anywhere; user-select: text; }
.dm-result__icon { margin-top: 2px; }
.dm-result__tip { overflow-wrap: anywhere; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 32px 0; }
/* One column on a phone: the cut cells take the row's width, not more. */
.dm-audit :deep(.v-data-table__tr--mobile) .audit-cell { max-width: 100% !important; }
.dm-audit :deep(.v-data-table__tr--mobile) .dm-result { max-width: 100%; }
</style>
