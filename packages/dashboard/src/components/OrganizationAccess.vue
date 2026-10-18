<script setup lang="ts">
// Organization access (packaging design §3): the roles the manager assumes, the accounts ready, those not ready with the
// reason and the procedure. Run now checks again.
import { computed, ref } from 'vue';
import { mdiAlertCircle, mdiCheck, mdiCheckCircle, mdiChevronDown, mdiClose, mdiCloseCircle, mdiFlashOffOutline, mdiOpenInNew, mdiShieldAlertOutline } from '@mdi/js';
import { accessHelp, accessLine, accessStatus, procedureLink, type AccessReport } from '../access';

const props = defineProps<{ report: AccessReport; roles?: { discoveryRole: string; commandRole: string } | null }>();
const all = ref(false);
const shown = computed(() => (all.value ? props.report.accounts : props.report.accounts.slice(0, 5)));
const notReady = computed(() => props.report.counts.discoveryMissing + props.report.counts.commandMissing > 0 || props.report.delegation === 'missing');
const link = procedureLink();
// The status icon: the counts and event-driven refresh are in its tooltip; the panel lists only what needs attention.
const status = computed(() => accessStatus(props.report));
const STATUS = {
  ok: { icon: mdiCheckCircle, color: 'success', label: 'all ready' },
  warning: { icon: mdiAlertCircle, color: 'warning', label: 'needs attention' },
  error: { icon: mdiCloseCircle, color: 'error', label: 'organization mode unavailable' },
} as const;
const help = computed(() => accessHelp(props.report));
const allImpossible = ref(false);
// The accounts where a forwarder is not possible, then those whose connect or disconnect failed, each with the reason.
const notConnected = computed(() => [...(props.report.forwarders?.failed ?? []).map((f) => ({ ...f, reason: `failed: ${f.reason}` })), ...(props.report.forwarders?.impossible ?? [])]);
const impossible = computed(() => (allImpossible.value ? notConnected.value : notConnected.value.slice(0, 5)));
</script>

<template>
  <v-card class="dm-access mb-4">
    <v-card-title class="d-flex flex-wrap align-center ga-2">
      Organization access
      <span class="dm-access__status" :class="`text-${STATUS[status].color}`">
        <v-tooltip location="top" max-width="440" open-on-click open-on-focus>
          <template #activator="{ props: tip }">
            <v-icon v-bind="tip" :icon="STATUS[status].icon" :color="STATUS[status].color" size="small" tabindex="0" role="img"
              :aria-label="`Organization access: ${STATUS[status].label}`" />
          </template>
          <p v-for="line in help" :key="line" class="dm-access__help my-1">{{ line }}</p>
        </v-tooltip>
        <span aria-hidden="true">{{ STATUS[status].label }}</span>
      </span>
    </v-card-title>
    <v-card-subtitle v-if="roles" class="text-wrap">The manager assumes <span class="dm-access__role">{{ roles.discoveryRole }}</span> (read-only) and <span class="dm-access__role">{{ roles.commandRole }}</span> (routers) in each
      account, roles set in its Terraform. Run now checks them again.</v-card-subtitle>
    <v-card-text v-if="report.delegation === 'missing' || shown.length || notConnected.length" class="pt-4">
      <v-alert v-if="report.delegation === 'missing'" type="warning" variant="tonal" density="compact" class="mb-3"
        text="Organization mode is unavailable: the delegation policy of the management account is missing, so the manager cannot list the accounts." />
      <ul v-if="shown.length" class="dm-access__list">
        <li v-for="a in shown" :key="a.account" class="dm-access__row">
          <v-avatar :color="a.discovery.ok ? 'warning' : 'error'" variant="tonal" rounded="lg" size="36" class="dm-access__flag"><v-icon :icon="mdiShieldAlertOutline" size="20" /></v-avatar>
          <div class="dm-access__who">
            <div class="text-body-medium"><span class="font-weight-medium">{{ a.name }}</span> <span class="mono text-medium-emphasis">({{ a.account }})</span><span class="dm-sr">: </span></div>
            <div class="text-body-small text-medium-emphasis">{{ accessLine(a) }}</div>
          </div>
          <div class="dm-access__roles">
            <v-chip :color="a.discovery.ok ? 'success' : 'error'" variant="tonal" label size="small" :prepend-icon="a.discovery.ok ? mdiCheck : mdiClose"
              :aria-label="`Discovery role: ${a.discovery.ok ? 'assumed' : 'missing'}`">discovery</v-chip>
            <v-chip :color="a.command.ok ? 'success' : 'error'" variant="tonal" label size="small" :prepend-icon="a.command.ok ? mdiCheck : mdiClose"
              :aria-label="`Command role: ${a.command.ok ? 'assumed' : 'missing'}`">command</v-chip>
          </div>
        </li>
      </ul>
      <v-btn v-if="report.accounts.length > shown.length" variant="text" size="small" class="mt-2" :append-icon="mdiChevronDown" @click="all = true">{{ report.accounts.length - shown.length }} more</v-btn>
      <template v-if="notConnected.length">
        <p class="dm-access__heading" :class="shown.length ? 'mt-5' : ''">Event-driven refresh is not possible or failed in:</p>
        <ul class="dm-access__list">
          <li v-for="f in impossible" :key="f.account" class="dm-access__row dm-access__row--quiet">
            <v-icon :icon="mdiFlashOffOutline" size="18" class="dm-access__flag text-medium-emphasis" />
            <div class="dm-access__who text-body-medium"><span class="font-weight-medium">{{ f.name }}</span> <span class="mono text-medium-emphasis">({{ f.account }})</span>: <span class="text-medium-emphasis">{{ f.reason }}</span></div>
          </li>
        </ul>
        <v-btn v-if="notConnected.length > impossible.length" variant="text" size="small" class="mt-2" :append-icon="mdiChevronDown" @click="allImpossible = true">
          {{ notConnected.length - impossible.length }} more</v-btn>
      </template>
    </v-card-text>
    <v-card-actions v-if="notReady" class="px-4 pb-4">
      <v-btn :href="link" target="_blank" rel="noopener" variant="tonal" :append-icon="mdiOpenInNew">How to set up the roles</v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.dm-access__status { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 6px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.05);
  font: 500 0.68rem/1.6 var(--dm-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.dm-access__help { font-size: 0.85rem; line-height: 1.45; }
.dm-access__role { font-family: var(--dm-mono); font-size: 0.85em; color: rgb(var(--v-theme-on-surface)); }
.dm-access__heading { margin-bottom: 8px; font-size: 0.86rem; font-weight: 500; }
.dm-access__list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.dm-access__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-access__row--quiet { grid-template-columns: auto minmax(0, 1fr); padding: 8px 12px; }
.dm-access__who { min-width: 0; overflow-wrap: anywhere; }
.dm-access__roles { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.dm-access__roles .v-chip { font-family: var(--dm-mono); font-size: 0.72rem; }
/* The colon between an account and its line: read, not shown (the line goes below). */
.dm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 600px) {
  .dm-access__row { grid-template-columns: auto minmax(0, 1fr); }
  .dm-access__roles { grid-column: 2; justify-content: flex-start; }
}
</style>
