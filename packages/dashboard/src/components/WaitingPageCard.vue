<script setup lang="ts">
// The waiting page of one level (router 0.35.0): its mode, where each field comes from, the cached favicon of a workload, a
// small preview, and for whoever may change it a dialog and a reset. The organization's level (the manager's settings) has
// its own route and shape, read here as a level with nothing above it. A read the account or the router cannot answer (a
// group member's 403, a router before 0.35.0's 409) says so calmly and shows nothing else.
import { computed, ref, watch } from 'vue';
import { useTheme } from 'vuetify';
import { mdiImageOutline, mdiPencilOutline } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useNow } from '../now';
import { useSession } from '../stores/session';
import {
  editRights, fromLine, organizationView, previewHtml, resolveDraft, whyNoIcon,
  type OrganizationPageView, type PageLevel, type StoredPage, type WaitingPageView,
} from '../waiting-page';
import DmLoader from './DmLoader.vue';
import type { Notice } from './NoticeAlert.vue';
import TerraformChip from './TerraformChip.vue';
import WaitingPageDialog from './WaitingPageDialog.vue';
import WaitingPagePreview from './WaitingPagePreview.vue';

// path: the API route of the level, for example /workloads/<router>/<id>/waiting-page.
const props = defineProps<{ level: PageLevel; path: string; subject: string }>();
const emit = defineEmits<{ notice: [Notice] }>();
const now = useNow();
const session = useSession();
const theme = useTheme();
const view = ref<WaitingPageView | null>(null);
const unavailable = ref('');
const open = ref(false);
const confirmReset = ref(false);
const saving = ref(false);
const saveError = ref('');

// The newest read wins; a failed read keeps what the card showed (after a save, the saved page is still there to read).
const stale = ref('');
let reads = 0;
async function load() {
  const mine = (reads += 1);
  try {
    const out = await api<WaitingPageView | OrganizationPageView>(props.path);
    if (mine !== reads) return;
    // A manager older than the feature answers something else: nothing to show.
    if (props.level === 'organization' ? !out || !('page' in out) : !out || !('effective' in out)) throw new Error('The waiting page is not available here yet.');
    view.value = props.level === 'organization' ? organizationView(out as OrganizationPageView) : out as WaitingPageView;
    unavailable.value = '';
    stale.value = '';
  } catch (err) {
    if (mine !== reads) return;
    const message = (err as { status?: number }).status === 403 ? 'The waiting page is not available to your account.' : (err as Error).message;
    if (view.value && loadedPath === props.path) stale.value = `The page could not be read again (${message}): what shows may be out of date.`;
    else { view.value = null; unavailable.value = message; }
  }
  loadedPath = props.path;
}
let loadedPath = '';
watch(() => props.path, () => { stale.value = ''; void load(); }, { immediate: true });

const rights = computed(() => (view.value ? editRights(props.level, session.acting, view.value.terraform, view.value.own, view.value.by) : { edit: false, custom: false, reset: false, reason: '' }));
const effective = computed(() => view.value?.effective);
const levelLabel = computed(() => (props.level === 'organization' ? 'Organization' : props.level === 'router' ? 'Router' : 'Workload'));
const iconText = computed(() => {
  const icon = effective.value?.icon ?? 'auto';
  return icon === 'none' ? 'None' : icon === 'auto' ? 'Automatic (the favicon)' : 'Uploaded image';
});
const size = computed(() => {
  const bytes = new TextEncoder().encode(effective.value?.html ?? '').length;
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
});
const favicon = computed(() => view.value?.favicon ?? null);
// Only a template is drawn here: a custom page is the customer's HTML, drawn only in the dialog's preview, opened on purpose.
const shown = computed(() => {
  const page = effective.value;
  if (!page || page.mode !== 'template') return '';
  const stored: StoredPage = resolveDraft({ mode: 'template' }, page);
  return previewHtml({ page: stored, favicon: favicon.value?.icon ?? null, state: 'waking', language: 'en', dark: theme.current.value.dark });
});
const terraformHelp = "Set in this workload's Terraform: change waiting_page in its workload module and apply.";
// Every level reaches visitors within about a minute: routers read the organization's page directly.
const reach = 'within about a minute';

async function save(page: StoredPage) {
  saving.value = true;
  saveError.value = '';
  try {
    await api(props.path, { method: 'PUT', body: JSON.stringify({ page }) });
    open.value = false;
    await load();
    emit('notice', { type: 'success', text: `Waiting page of ${props.subject} saved: visitors see it ${reach}.` });
  } catch (err) {
    saveError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}
async function reset() {
  saving.value = true;
  try {
    await api(props.path, { method: 'DELETE' });
    await load();
    emit('notice', { type: 'success', text: `Waiting page of ${props.subject} reset: visitors see the level above ${reach}.` });
  } catch (err) {
    emit('notice', { type: 'error', text: (err as Error).message });
  } finally {
    saving.value = false;
    confirmReset.value = false;
  }
}
</script>

<template>
  <v-card data-test="waiting-page-card" class="dm-wp-card">
    <v-card-item>
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiImageOutline" size="19" /></v-avatar></template>
      <v-card-title>Waiting page <v-chip v-if="level === 'organization'" data-test="waiting-page-level" size="small" label variant="tonal" class="ml-1">{{ levelLabel }}</v-chip></v-card-title>
      <template v-if="view && (rights.edit || rights.reset)" #append>
        <v-btn v-if="rights.edit" data-test="edit-waiting-page" :prepend-icon="mdiPencilOutline" variant="text" size="small" @click="saveError = ''; open = true">{{ view.own ? 'Edit' : 'Customize' }}</v-btn>
        <v-btn v-if="rights.reset" data-test="reset-waiting-page" variant="text" size="small" color="error" @click="confirmReset = true">Reset</v-btn>
      </template>
    </v-card-item>
    <v-card-text v-if="unavailable" data-test="waiting-page-unavailable" class="text-medium-emphasis pt-0">{{ unavailable }}</v-card-text>
    <DmLoader v-else-if="!view" label="Reading the waiting page…" :size="48" />
    <template v-else-if="effective">
      <v-card-text class="pt-0">
        <p class="text-body-small text-medium-emphasis mb-3">What visitors read while the application wakes.
          {{ level === 'organization' ? 'Every router reads this; a router or a workload can override it.' : level === 'router' ? 'Its workloads inherit it unless they set their own.' : 'It overrides the router and the organization, field by field.' }}</p>
        <div class="dm-wp-card__grid">
          <dl class="dm-wp-card__facts">
            <div data-test="field-mode">
              <dt>Page</dt>
              <dd>{{ effective.mode === 'custom' ? `Custom HTML (${size})` : 'Template' }} <span class="dm-wp-card__from">{{ fromLine(effective.from.mode) }}</span></dd>
            </div>
            <template v-if="effective.mode === 'template'">
              <div data-test="field-icon">
                <dt>Icon</dt>
                <dd>{{ iconText }} <span class="dm-wp-card__from">{{ fromLine(effective.from.icon) }}</span></dd>
              </div>
              <div data-test="field-title">
                <dt>Title</dt>
                <dd><template v-if="effective.title">{{ effective.title }} <span class="dm-wp-card__from">{{ fromLine(effective.from.title) }}</span></template><span v-else class="text-medium-emphasis">none</span></dd>
              </div>
              <div data-test="field-description">
                <dt>Description</dt>
                <dd class="dm-wp-card__note"><template v-if="effective.description">{{ effective.description }} <span class="dm-wp-card__from">{{ fromLine(effective.from.description) }}</span></template><span v-else class="text-medium-emphasis">none</span></dd>
              </div>
            </template>
            <div v-if="level === 'workload'" data-test="favicon">
              <dt>Cached favicon</dt>
              <dd v-if="favicon?.icon" class="dm-wp-card__favicon"><img :src="favicon.icon" alt=""><span>read {{ relative(favicon.fetchedAt, now) }}<template v-if="favicon.error"> (the last read failed: {{ favicon.error }})</template></span></dd>
              <dd v-else class="text-medium-emphasis">none: {{ whyNoIcon(favicon) }}</dd>
            </div>
          </dl>
          <WaitingPagePreview v-if="shown && effective.mode === 'template'" :html="shown" title="Preview of the waiting page" mini />
        </div>
      </v-card-text>
      <v-card-text v-if="view.warnings.length" class="pt-0">
        <v-alert v-for="w in view.warnings" :key="w" type="warning" variant="tonal" density="compact" class="mb-2" :text="w" />
      </v-card-text>
      <v-card-text v-if="view.own && view.by" class="pt-0 text-body-small text-medium-emphasis">Set by {{ view.by }}{{ view.at ? `, ${relative(view.at, now)}` : '' }}.</v-card-text>
      <v-card-text v-if="stale" data-test="waiting-page-stale" class="pt-0 text-body-small text-warning">{{ stale }}</v-card-text>
      <v-card-text v-if="rights.reason" data-test="waiting-page-reason" class="pt-0 text-body-small text-medium-emphasis">
        <TerraformChip v-if="view.terraform" size="x-small" variant="tonal" :text="terraformHelp" class="mr-1" />{{ rights.reason }}
        <template v-if="rights.reset"> A page the manager set before the workload moved to Terraform can still be reset here.</template>
      </v-card-text>
    </template>
    <WaitingPageDialog v-if="view" v-model="open" :level="level" :subject="subject" :own="view.own" :inherited="view.inherited" :favicon="favicon?.icon ?? null"
      :can-custom="rights.custom" :saving="saving" :error="saveError" @submit="save" />
    <v-dialog v-model="confirmReset" max-width="440">
      <v-card data-test="confirm-reset-waiting-page-dialog" title="Reset the waiting page?">
        <v-card-text class="text-medium-emphasis">The page set on {{ subject }} is removed, and visitors see what the level above gives. A custom page cannot be recovered.</v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="confirmReset = false">Keep it</v-btn>
          <v-btn data-test="confirm-reset-waiting-page" color="error" variant="flat" :loading="saving" @click="reset">Reset</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.dm-wp-card__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 220px); gap: 16px; align-items: start; }
.dm-wp-card__facts { margin: 0; display: grid; gap: 8px; min-width: 0; }
.dm-wp-card__facts dt { font: 500 0.66rem/1.2 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-wp-card__facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.dm-wp-card__note { white-space: pre-line; }
.dm-wp-card__from { margin-left: 4px; padding: 1px 6px; border-radius: 6px; font-size: 0.72rem; background: rgba(var(--v-theme-on-surface), 0.07); color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); white-space: nowrap; }
.dm-wp-card__favicon { display: flex; align-items: center; gap: 8px; }
.dm-wp-card__favicon img { max-height: 24px; max-width: 64px; }
@media (max-width: 599px) { .dm-wp-card__grid { grid-template-columns: minmax(0, 1fr); } }
</style>
