<script setup lang="ts">
// "paused" or "excluded" next to a state, with who, when, why and the automatic resume of every pause in the tooltip.
import { computed } from 'vue';
import { mdiCancel, mdiPauseCircleOutline } from '@mdi/js';
import { useNow } from '../now';
import { pauseLabel, pauseLine } from '../pause';
import type { Pause } from '../types';

const props = defineProps<{ pauses?: Pause[] }>();
const now = useNow();
const label = computed(() => pauseLabel(props.pauses));
</script>

<template>
  <v-tooltip v-if="label" location="top" max-width="420" open-on-click open-on-focus>
    <template #activator="{ props: activator }">
      <v-chip v-bind="activator" :prepend-icon="label === 'excluded' ? mdiCancel : mdiPauseCircleOutline" color="secondary" variant="tonal" label tabindex="0">{{ label }}</v-chip>
    </template>
    <div v-for="p in pauses" :key="`${p.scope}/${p.exclusionId ?? ''}`" class="text-body-medium">{{ pauseLine(p, now) }}</div>
    <div class="text-body-small mt-1">Never napped while paused; requests still wake it.</div>
  </v-tooltip>
</template>
