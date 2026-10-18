<script setup lang="ts">
import { mdiRefresh, mdiTimerCogOutline } from '@mdi/js';
import { useNow } from '../now';
import { refreshLabel } from '../format';
import { usePreferences } from '../stores/preferences';

defineProps<{ nextAt: number | null; loading: boolean }>();
defineEmits<{ refresh: [] }>();
const now = useNow();
const preferences = usePreferences();
const choices = [
  { title: 'Off', value: 0 }, { title: 'Every 5 s', value: 5 }, { title: 'Every 10 s', value: 10 }, { title: 'Every 30 s', value: 30 },
  { title: 'Every minute', value: 60 }, { title: 'Every 5 min', value: 300 },
];
</script>

<template>
  <div class="dm-refresh text-body-small" :class="{ 'is-loading': loading }">
    <span class="dm-refresh__dot" :class="{ 'is-on': preferences.refreshSeconds > 0 }" aria-hidden="true" />
    <span class="dm-refresh__label nowrap" aria-live="off">{{ refreshLabel({ seconds: preferences.refreshSeconds, nextAt, loading }, now) }}</span>
    <!-- While loading, the button spins its icon and takes no click, as a loading button does. -->
    <v-btn :icon="mdiRefresh" size="small" density="comfortable" variant="text" class="dm-refresh__now" :class="{ 'is-spinning': loading }"
      :aria-busy="loading || undefined" :tabindex="loading ? -1 : undefined" aria-label="Refresh now" @click="$emit('refresh')" />
    <v-menu location="bottom end">
      <template #activator="{ props }">
        <v-btn v-bind="props" :icon="mdiTimerCogOutline" size="small" density="comfortable" variant="text" aria-label="Refresh interval" />
      </template>
      <v-list density="compact" min-width="220" color="secondary" class="dm-interval" :selected="[preferences.refreshSeconds]" @update:selected="(v: unknown[]) => preferences.setRefresh(Number(v[0]))">
        <v-list-subheader>Refresh interval (saved)</v-list-subheader>
        <v-list-item v-for="c in choices" :key="c.value" :value="c.value" :title="c.title" />
      </v-list>
    </v-menu>
  </div>
</template>

<style scoped>
/* A quiet pill: the countdown, refresh now, the interval. */
.dm-refresh { display: inline-flex; align-items: center; gap: 2px; height: 36px; padding: 0 3px 0 12px; border-radius: 999px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), 0.03); color: rgba(var(--v-theme-on-surface), 0.7);
  backdrop-filter: blur(8px); }
.dm-refresh__dot { flex: none; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: rgba(var(--v-theme-on-surface), 0.3); transition: background-color 0.3s; }
.dm-refresh__dot.is-on { background: rgb(var(--v-theme-success)); box-shadow: 0 0 0 3px rgba(var(--v-theme-success), 0.16); }
.dm-refresh.is-loading .dm-refresh__dot.is-on { background: rgb(var(--v-theme-secondary)); box-shadow: 0 0 0 3px rgba(var(--v-theme-secondary), 0.18); }
.dm-refresh__label { min-width: 6.6rem; margin-right: 2px; font-variant-numeric: tabular-nums; }
.dm-refresh .v-btn { color: rgba(var(--v-theme-on-surface), 0.8); }
.dm-refresh__now.is-spinning { pointer-events: none; color: rgb(var(--v-theme-secondary)); }
.dm-refresh__now.is-spinning :deep(.v-icon) { animation: dm-refresh-spin 0.9s linear infinite; }
.dm-interval :deep(.v-list-subheader) { font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; min-height: 30px; }
@keyframes dm-refresh-spin { to { transform: rotate(360deg); } }
@keyframes dm-refresh-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
  .dm-refresh__now.is-spinning :deep(.v-icon) { animation: dm-refresh-pulse 1.4s ease-in-out infinite; }
}
</style>
