<script setup lang="ts">
// A router's workloads by state (the Routers list and a router's view, tables design §4): a chip per state, its icon then
// ×N in its color, opening those workloads; the paused ones in one more chip of the same form, in the pause's color, with or
// without the states' counts. The default slot comes first: a view's count where no state has one to show. A state's chip is
// named by what it shows (×N) first; the tooltips say what each chip counts.
import { mdiPauseCircleOutline } from '@mdi/js';
import { stateColor } from '../format';
import { countLabel, pausedHelp, workloadsHelp } from '../router-actions';
import { stateIcon } from '../state';
import type { RouterInfo } from '../types';

defineProps<{ router: RouterInfo }>();
const emit = defineEmits<{ open: [state: string, count: number] }>();
</script>

<template>
  <div class="dm-counts">
    <slot />
    <!-- Each tooltip says the chip's name again in words: for the eye, not read twice. -->
    <v-tooltip v-for="(n, state) in router.workloadStates ?? {}" :key="state" location="top" max-width="380" open-on-focus>
      <template #activator="{ props: tip }">
        <v-chip v-bind="tip" :color="stateColor(String(state))" variant="tonal" size="small" label link role="button" data-test="state-count"
          :aria-label="countLabel(router.name, String(state), n)" class="dm-count" @click="emit('open', String(state), n)">
          <v-icon :icon="stateIcon(String(state))" size="15" aria-hidden="true" /><span class="dm-count__n">×{{ n }}</span>
        </v-chip>
      </template>
      <span aria-hidden="true">{{ workloadsHelp(router.name, String(state), n) }}</span>
    </v-tooltip>
    <!-- The paused ones open nothing: outlined, not drawn as the chips a click opens. -->
    <v-tooltip v-if="router.paused" location="top" max-width="380" open-on-focus>
      <template #activator="{ props: tip }">
        <v-chip v-bind="tip" color="secondary" variant="outlined" size="small" label role="img" tabindex="0" data-test="paused-count"
          :aria-label="pausedHelp(router.name, router.paused, Boolean(router.pauses?.length))" class="dm-count">
          <v-icon :icon="mdiPauseCircleOutline" size="15" aria-hidden="true" /><span class="dm-count__n">×{{ router.paused }}</span>
        </v-chip>
      </template>
      <span aria-hidden="true">{{ pausedHelp(router.name, router.paused, Boolean(router.pauses?.length)) }}</span>
    </v-tooltip>
  </div>
</template>

<style scoped>
.dm-counts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dm-count { flex: none; }
[data-test="paused-count"] { cursor: default; }
.dm-count:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.dm-count__n { margin-inline-start: 3px; font-variant-numeric: tabular-nums; font-weight: 500; }
</style>
