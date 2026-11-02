<script setup lang="ts">
// A page's title on one line (the user, 2026-11-02): its section and its name, "FLEET / Schedules", a way back first when the page
// has one, and what follows the name in the `after` slot (a running count).
import { mdiArrowLeft } from '@mdi/js';

defineProps<{ eyebrow: string; title: string; back?: string; backLabel?: string }>();
</script>

<template>
  <div data-test="page-title" class="dm-page-title">
    <v-btn v-if="back" :icon="mdiArrowLeft" variant="text" size="x-small" class="dm-page-title__back" :to="back" :aria-label="backLabel" />
    <span class="dm-eyebrow">{{ eyebrow }}</span>
    <span class="dm-page-title__sep" aria-hidden="true">/</span>
    <h1 class="text-headline-small dm-page-title__name">{{ title }}</h1>
    <slot name="after" />
  </div>
</template>

<style scoped>
.dm-page-title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.dm-page-title__back { margin-inline: -6px -4px; }
.dm-page-title__sep { color: rgba(var(--v-theme-on-surface), 0.35); }
.dm-page-title__name { margin: 0; line-height: 1.2; overflow-wrap: anywhere; }
</style>
