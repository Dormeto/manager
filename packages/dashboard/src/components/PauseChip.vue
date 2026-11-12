<script setup lang="ts">
// A pause as its icon alone (tables design §3), beside a state: "paused" or "excluded" is its name and its tooltip's first
// line, who, when, why and the automatic resume of every pause under it.
import { computed } from 'vue';
import { mdiCancel, mdiPauseCircleOutline } from '@mdi/js';
import { useNow } from '../now';
import { pauseLabel, pauseLine } from '../pause';
import StatusMark from './StatusMark.vue';
import type { Pause } from '../types';

const props = defineProps<{ pauses?: Pause[] }>();
const now = useNow();
const label = computed(() => pauseLabel(props.pauses));
</script>

<template>
  <StatusMark v-if="label" :icon="label === 'excluded' ? mdiCancel : mdiPauseCircleOutline" color="secondary" :label="label" class="dm-pause">
    <div v-for="p in pauses" :key="`${p.scope}/${p.exclusionId ?? ''}`" class="text-body-medium">{{ pauseLine(p, now) }}</div>
    <div class="text-body-small mt-1 dm-pause__note">Never napped while paused; requests still wake it.</div>
  </StatusMark>
</template>

<style scoped>
.dm-pause__note { opacity: 0.8; }
</style>
