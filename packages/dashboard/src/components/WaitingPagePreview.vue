<script setup lang="ts">
// A waiting page's HTML in a frame that is the security boundary between a customer's page and the dashboard: sandboxed with
// no token at all, so no script runs and the page has an opaque origin (no cookies, no storage, no access to this document).
// `mini` draws the page at twice the size, scaled down, for a card.
defineProps<{ html: string; title: string; mini?: boolean }>();
</script>

<template>
  <div class="dm-wp-frame" :class="{ 'dm-wp-frame--mini': mini }" :aria-hidden="mini ? 'true' : undefined">
    <iframe sandbox="" :srcdoc="html" :title="title" referrerpolicy="no-referrer" tabindex="-1" />
  </div>
</template>

<style scoped>
.dm-wp-frame { overflow: hidden; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 12px; background: rgb(var(--v-theme-surface)); }
.dm-wp-frame iframe { display: block; width: 100%; height: 100%; min-height: 360px; border: 0; }
.dm-wp-frame--mini { position: relative; aspect-ratio: 16 / 10; }
.dm-wp-frame--mini iframe { position: absolute; top: 0; left: 0; width: 200%; height: 200%; min-height: 0; transform: scale(0.5); transform-origin: 0 0; pointer-events: none; }
</style>
