<script setup lang="ts">
// A router's workloads by state (the Routers list and a router's view, tables design §4): a chip per state, its icon then
// ×N in its color, opening those workloads; the paused ones in one more chip of the same form, in the pause's color. Each
// chip is named by what its tooltip says (the count, the state, what a click does).
import { mdiPauseCircleOutline } from '@mdi/js';
import { stateColor } from '../format';
import { pausedHelp, workloadsHelp } from '../router-actions';
import { stateIcon } from '../state';
import type { RouterInfo } from '../types';

defineProps<{ router: RouterInfo }>();
const emit = defineEmits<{ open: [state: string, count: number] }>();
</script>

<template>
  <div class="dm-counts">
    <v-tooltip v-for="(n, state) in router.workloadStates ?? {}" :key="state" location="top" max-width="380" open-on-focus :text="workloadsHelp(router.name, String(state), n)">
      <template #activator="{ props: tip }">
        <v-chip v-bind="tip" :color="stateColor(String(state))" variant="tonal" size="small" label link role="button" data-test="state-count"
          :aria-label="workloadsHelp(router.name, String(state), n)" class="dm-count" @click="emit('open', String(state), n)">
          <v-icon :icon="stateIcon(String(state))" size="15" aria-hidden="true" /><span class="dm-count__n">×{{ n }}</span>
        </v-chip>
      </template>
    </v-tooltip>
    <v-tooltip v-if="router.paused" location="top" max-width="380" open-on-focus :text="pausedHelp(router.name, router.paused, Boolean(router.pauses?.length))">
      <template #activator="{ props: tip }">
        <v-chip v-bind="tip" color="secondary" variant="tonal" size="small" label role="img" tabindex="0" data-test="paused-count"
          :aria-label="pausedHelp(router.name, router.paused, Boolean(router.pauses?.length))" class="dm-count">
          <v-icon :icon="mdiPauseCircleOutline" size="15" aria-hidden="true" /><span class="dm-count__n">×{{ router.paused }}</span>
        </v-chip>
      </template>
    </v-tooltip>
  </div>
</template>

<style scoped>
.dm-counts { display: flex; flex-wrap: wrap; gap: 4px; }
.dm-count { flex: none; }
.dm-count:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.dm-count__n { margin-inline-start: 3px; font-variant-numeric: tabular-nums; font-weight: 500; }
</style>
