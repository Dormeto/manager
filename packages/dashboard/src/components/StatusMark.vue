<script setup lang="ts">
// A status as its icon alone (tables design §3): its word is the icon's accessible name and the tooltip's first line, the
// slot's lines follow (who, when, why, an error's text). Focusable, so a keyboard opens the tooltip too; `pulse` breathes
// while something runs. The word itself goes in the exports, from the column's text. A view's class lands on the mark.
defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ icon: string; color?: string; label: string; pulse?: boolean; size?: number | string }>(), { color: undefined, pulse: false, size: 20 });
</script>

<template>
  <v-tooltip location="top" max-width="420" open-on-focus>
    <template #activator="{ props: tip }">
      <span v-bind="{ ...$attrs, ...tip }" data-test="status-mark" class="dm-status" :class="[color ? `text-${color}` : 'dm-status--plain', { 'dm-status--pulse': pulse }]" role="img"
        :aria-label="label" tabindex="0"><v-icon :icon="icon" :size="size" aria-hidden="true" /></span>
    </template>
    <div class="dm-status__label">{{ label }}</div>
    <slot />
  </v-tooltip>
</template>

<style scoped>
.dm-status { display: inline-flex; align-items: center; justify-content: center; flex: none; vertical-align: middle; border-radius: 50%; cursor: default; }
.dm-status:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.dm-status--plain { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-status__label { font-weight: 600; }
.dm-status--pulse { animation: dm-status-pulse 1.8s ease-in-out infinite; }
@keyframes dm-status-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); }
  60% { box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) { .dm-status--pulse { animation: none; } }
</style>
