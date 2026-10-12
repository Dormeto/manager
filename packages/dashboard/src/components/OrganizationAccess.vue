<script setup lang="ts">
// Organization access (packaging design §3): the roles the manager assumes, the accounts ready, those not ready with the
// reason and the procedure. Run now checks again.
import { computed, ref } from 'vue';
import { mdiAlertCircle, mdiCheckCircle, mdiCloseCircle, mdiOpenInNew } from '@mdi/js';
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
  <v-card class="mb-4">
    <v-card-title class="d-flex align-center ga-2">
      Organization access
      <v-tooltip location="top" max-width="440" open-on-click open-on-focus>
        <template #activator="{ props: tip }">
          <v-icon v-bind="tip" :icon="STATUS[status].icon" :color="STATUS[status].color" size="small" tabindex="0" role="img"
            :aria-label="`Organization access: ${STATUS[status].label}`" />
        </template>
        <p v-for="line in help" :key="line" class="text-body-medium my-1">{{ line }}</p>
      </v-tooltip>
    </v-card-title>
    <v-card-subtitle v-if="roles" class="text-wrap">The manager assumes {{ roles.discoveryRole }} (read-only) and {{ roles.commandRole }} (routers) in each
      account, roles set in its Terraform. Run now checks them again.</v-card-subtitle>
    <v-card-text v-if="report.delegation === 'missing' || shown.length || notConnected.length">
      <v-alert v-if="report.delegation === 'missing'" type="warning" variant="tonal" density="compact" class="mb-3"
        text="Organization mode is unavailable: the delegation policy of the management account is missing, so the manager cannot list the accounts." />
      <ul v-if="shown.length" class="pl-4">
        <li v-for="a in shown" :key="a.account" class="text-body-medium">{{ a.name }} ({{ a.account }}): {{ accessLine(a) }}</li>
      </ul>
      <v-btn v-if="report.accounts.length > shown.length" variant="text" size="small" @click="all = true">{{ report.accounts.length - shown.length }} more</v-btn>
      <template v-if="notConnected.length">
        <p class="mt-3">Event-driven refresh is not possible or failed in:</p>
        <ul class="mt-2 pl-4">
          <li v-for="f in impossible" :key="f.account" class="text-body-medium">{{ f.name }} ({{ f.account }}): {{ f.reason }}</li>
        </ul>
        <v-btn v-if="notConnected.length > impossible.length" variant="text" size="small" @click="allImpossible = true">
          {{ notConnected.length - impossible.length }} more</v-btn>
      </template>
    </v-card-text>
    <v-card-actions v-if="notReady">
      <v-btn :href="link" target="_blank" rel="noopener" variant="tonal" :append-icon="mdiOpenInNew">How to set up the roles</v-btn>
    </v-card-actions>
  </v-card>
</template>
