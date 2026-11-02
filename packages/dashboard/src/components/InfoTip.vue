<script setup lang="ts">
// What a title or a setting means, in the tooltip of an information icon beside it rather than in a paragraph under it (the user,
// 2026-11-02): on hover and on keyboard focus. `test` names the icon (<test>-more) and the text (<test>-tip).
import { mdiInformationOutline } from '@mdi/js';

defineProps<{ label: string; test: string; maxWidth?: number }>();
</script>

<template>
  <v-tooltip location="top" :max-width="maxWidth ?? 360" open-on-focus>
    <template #activator="{ props: activator }">
      <v-icon v-bind="activator" :data-test="`${test}-more`" :icon="mdiInformationOutline" size="16" tabindex="0" :aria-label="label" class="dm-info" />
    </template>
    <div :data-test="`${test}-tip`"><slot /></div>
  </v-tooltip>
</template>

<style scoped>
.dm-info { opacity: 0.6; border-radius: 50%; outline: none; }
.dm-info:hover, .dm-info:focus-visible { opacity: 1; }
.dm-info:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
</style>
