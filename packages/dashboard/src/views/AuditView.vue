<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { ref } from 'vue';
import { mdiAlertCircleOutline, mdiCheck } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';

interface Entry { id: string; at: string; who: string; role: string; action: string; target: string; result: string }

const now = useNow();
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
// Cut on one line at these widths, the full text in a tooltip.
const CUT = { action: '14rem', target: '24rem' } as const;

// Presentation: the exact time behind the relative one, the initials on the brand's blue (as the navigation's).
const exact = (iso: string) => new Date(iso).toLocaleString('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
const initials = (email: string) => (email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
const failed = (e: Entry) => e.result.startsWith('error');
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-6">
    <div>
      <div class="dm-eyebrow mb-1">Administration</div>
      <h1 class="text-headline-small">Audit</h1>
      <p class="text-medium-emphasis mt-2 mb-0">Every action taken from the dashboard or the API, kept 90 days.</p>
    </div>
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card class="dm-audit">
    <v-data-table :mobile="smAndDown" :headers="headers" :items="entries" :loading="loading" item-value="id" :items-per-page="50" :sort-by="[{ key: 'at', order: 'desc' }]">
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
        <!-- Whole: an error in red, wrapping and selectable (a chip's text is not), as before the redesign; else a chip. -->
        <div v-if="failed(item)" data-test="audit-result" class="dm-result dm-result--error text-error">
          <v-icon :icon="mdiAlertCircleOutline" color="error" size="14" class="dm-result__icon" /><span>{{ item.result }}</span>
        </div>
        <v-chip v-else data-test="audit-result" variant="tonal" label class="dm-result">
          <template #prepend><v-icon :icon="mdiCheck" color="success" size="14" class="mr-1" /></template>
          <span>{{ item.result }}</span>
        </v-chip>
      </template>
    </v-data-table>
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
.dm-result--error { display: flex; align-items: flex-start; gap: 6px; max-width: 36rem; padding: 6px 0; font-size: 0.875rem; line-height: 1.45; white-space: normal;
  overflow-wrap: anywhere; user-select: text; }
.dm-result__icon { flex: none; margin-top: 3px; }
/* The others' chip wraps too, rather than widen the table past the card (which would cut the results anew). */
.dm-result.v-chip { max-width: 24rem; height: auto; min-height: var(--v-chip-height); padding-block: 3px; white-space: normal; }
.dm-result :deep(.v-chip__content) { min-width: 0; overflow-wrap: anywhere; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 32px 0; }
.dm-audit :deep(.v-data-table-rows-loading > td), .dm-audit :deep(.v-data-table-rows-no-data > td) { height: auto !important; }
.dm-audit :deep(.v-data-table-footer) { padding-inline: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
/* One column on a phone: the cut cells take the row's width, not more. */
.dm-audit :deep(.v-data-table__td-value) { min-width: 0; }
.dm-audit :deep(.v-data-table__tr--mobile > td) { grid-template-columns: auto minmax(0, 1fr); column-gap: 16px; }
.dm-audit :deep(.v-data-table__tr--mobile) .audit-cell { max-width: 100% !important; }
.dm-audit :deep(.v-data-table__tr--mobile) .dm-result { max-width: 100%; }
</style>
