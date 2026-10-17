<script setup lang="ts">
// The idle share of the last 7 days as a bar colored from red (busy) to green (idle); the figures and their source in a
// tooltip.
import { computed } from 'vue';
import { idleColor, idleText } from '../discovery';

const props = defineProps<{ idleHours7d: number; requests7d: number | null }>();
const text = computed(() => idleText(props));
const share = computed(() => Math.min(100, Math.max(0, (100 * props.idleHours7d) / 168)));
</script>

<template>
  <v-tooltip location="top" max-width="380">
    <template #activator="{ props: tip }">
      <div v-bind="tip" class="idle-bar" tabindex="0" role="img" :aria-label="text.title">
        <span class="idle-bar__track"><span class="idle-bar__fill" :style="{ width: `${share}%`, backgroundColor: idleColor(idleHours7d) }" /></span>
      </div>
    </template>
    <div class="font-weight-bold">{{ text.title }}</div>
    <div>{{ text.detail }}</div>
    <div class="mt-1 note">From the load balancer's CloudWatch metric RequestCount for this target group, hour by hour, read by
      discovery: no onboarding needed. Every request counts, bots and scanners included: an estimate of how long it could sleep.</div>
  </v-tooltip>
</template>

<style scoped>
.idle-bar { width: 80px; padding: 6px 0; margin-left: auto; border-radius: 6px; outline: none; }
.idle-bar:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
.idle-bar__track { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: rgba(var(--v-theme-on-surface), 0.1); }
.idle-bar__fill { display: block; height: 100%; min-width: 3px; border-radius: 999px; transform-origin: left center; animation: dm-idle-in 0.8s var(--dm-ease) both; transition: filter 0.2s; }
.idle-bar:hover .idle-bar__fill { filter: brightness(1.12); }
@keyframes dm-idle-in { from { transform: scaleX(0); } }
.note { opacity: 0.8; }
@media (prefers-reduced-motion: reduce) { .idle-bar__fill { animation: none; } }
</style>
