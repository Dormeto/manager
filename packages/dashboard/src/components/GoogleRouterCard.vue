<script setup lang="ts">
// A Google Cloud router's commands: the manager installs, upgrades and uninstalls AWS routers, but a Google Cloud router is
// installed by the CLI, which checks and changes the project's IAM policy itself. So no button here: the commands, and the
// router's controller in the console.
import { computed } from 'vue';
import { mdiConsoleLine, mdiOpenInNew } from '@mdi/js';
import { controllerConsoleUrl, installCommand, uninstallCommand } from '../google';
import { atLeast } from '../format';
import type { RouterInfo } from '../types';

// pinned: the router version this manager pins; the install command carries it while the router is behind: its version below
// the pinned one, or too old to report whatever its version (the API's refusal router-too-old, its version perhaps unknown).
const props = defineProps<{ router: RouterInfo; pinned: string | null }>();
const project = computed(() => props.router.account ?? '');
const behind = computed(() => Boolean(props.pinned && (props.router.refusal === 'router-too-old' || (props.router.version && !atLeast(props.router.version, props.pinned)))));
const install = computed(() => installCommand(project.value, props.router.region, behind.value ? props.pinned : null));
</script>

<template>
  <v-card data-test="gcp-router">
    <v-card-item>
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiConsoleLine" size="19" /></v-avatar></template>
      <v-card-title>Install and uninstall</v-card-title>
      <v-card-subtitle class="text-wrap">A Google Cloud router is installed, upgraded and uninstalled with the Dormeto CLI, in a terminal signed in to the project.</v-card-subtitle>
    </v-card-item>
    <v-card-text class="pt-2 text-body-medium">
      <div class="mb-1">{{ behind ? `Upgrade to ${pinned}` : 'Install, or reinstall' }}</div>
      <code data-test="gcp-install" class="dm-cmd">{{ install }}</code>
      <div class="mt-3 mb-1">Uninstall (after offboarding its workloads)</div>
      <code data-test="gcp-uninstall" class="dm-cmd">{{ uninstallCommand(project, router.region) }}</code>
      <div class="mt-3">
        <a data-test="gcp-controller" :href="controllerConsoleUrl(project, router.region)" target="_blank" rel="noopener">Its controller in the Google Cloud console<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.dm-cmd { display: block; padding: 8px 12px; border-radius: 10px; overflow-wrap: anywhere; font: 500 0.82rem/1.5 var(--dm-mono); background: rgba(var(--v-theme-on-surface), 0.05); }
</style>
