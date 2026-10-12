<script setup lang="ts">
// The idle share of the last 7 days as a bar colored from red (busy) to green (idle); the figures and their source in a
// tooltip.
import { computed } from 'vue';
import { idleColor, idleText } from '../discovery';

const props = defineProps<{ idleHours7d: number; requests7d: number | null }>();
const text = computed(() => idleText(props));
</script>

<template>
  <v-tooltip location="top" max-width="380">
    <template #activator="{ props: tip }">
      <div v-bind="tip" class="idle-bar" tabindex="0" role="img" :aria-label="text.title">
        <v-progress-linear :model-value="(100 * idleHours7d) / 168" :color="idleColor(idleHours7d)" height="8" rounded />
      </div>
    </template>
    <div class="font-weight-bold">{{ text.title }}</div>
    <div>{{ text.detail }}</div>
    <div class="mt-1 note">From the load balancer's CloudWatch metric RequestCount for this target group, hour by hour, read by
      discovery: no onboarding needed. Every request counts, bots and scanners included: an estimate of how long it could sleep.</div>
  </v-tooltip>
</template>

<style scoped>
.idle-bar { width: 80px; padding: 6px 0; margin-left: auto; }
.note { opacity: 0.8; }
</style>
