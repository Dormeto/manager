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
  <div class="d-flex align-center ga-1 text-body-small text-medium-emphasis">
    <span class="nowrap" aria-live="off">{{ refreshLabel({ seconds: preferences.refreshSeconds, nextAt, loading }, now) }}</span>
    <v-btn :icon="mdiRefresh" size="small" variant="text" :loading="loading" aria-label="Refresh now" @click="$emit('refresh')" />
    <v-menu>
      <template #activator="{ props }">
        <v-btn v-bind="props" :icon="mdiTimerCogOutline" size="small" variant="text" aria-label="Refresh interval" />
      </template>
      <v-list density="compact" :selected="[preferences.refreshSeconds]" @update:selected="(v: unknown[]) => preferences.setRefresh(Number(v[0]))">
        <v-list-subheader>Refresh interval (saved)</v-list-subheader>
        <v-list-item v-for="c in choices" :key="c.value" :value="c.value" :title="c.title" />
      </v-list>
    </v-menu>
  </div>
</template>
