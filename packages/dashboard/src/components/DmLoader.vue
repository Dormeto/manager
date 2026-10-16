<script setup lang="ts">
// A view's loading: the Dormeto icon turns its sun's rays, then wakes (the eyes open) when done is set.
import DmLogo from './DmLogo.vue';

withDefaults(defineProps<{ label?: string; size?: number; done?: boolean }>(), { label: 'Loading…', size: 72, done: false });
</script>

<template>
  <div class="dm-loader" role="status" aria-live="polite">
    <div class="dm-loader__glow" aria-hidden="true" />
    <DmLogo :state="done ? 'wake' : 'load'" :size="size" />
    <span class="dm-loader__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.dm-loader { position: relative; display: grid; justify-items: center; gap: 16px; padding: 56px 16px; }
.dm-loader__glow { position: absolute; top: 18px; width: 220px; height: 160px; border-radius: 50%; filter: blur(40px); opacity: 0.55;
  background: radial-gradient(closest-side, rgba(69, 137, 202, 0.55), rgba(255, 155, 85, 0.25) 60%, transparent); animation: dm-glow 2.4s ease-in-out infinite; }
.dm-loader__label { position: relative; font: 500 0.72rem/1 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.7; }
@keyframes dm-glow { 50% { opacity: 0.85; transform: scale(1.08); } }
@media (prefers-reduced-motion: reduce) { .dm-loader__glow { animation: none; } }
</style>
