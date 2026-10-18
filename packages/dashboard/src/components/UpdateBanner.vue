<script setup lang="ts">
// The daily update check's notice (administrators): the last check names a newer version than the one running, until the
// user dismisses it for that version (kept in their preferences).
import { computed, onMounted, ref } from 'vue';
import { mdiUpdate } from '@mdi/js';
import { api } from '../api';
import { usePreferences } from '../stores/preferences';
import { useSession } from '../stores/session';
import type { UpdateCheck } from '../update';

const session = useSession();
const preferences = usePreferences();
const latest = ref<string | null>(null);
const shown = computed(() => latest.value !== null && latest.value !== preferences.dismissedUpdate);

onMounted(async () => {
  if (!session.isAdmin) return;
  try {
    const check = await api<Partial<UpdateCheck>>('/update/check');
    // The API judges it against the version running now.
    latest.value = check.newer === true && typeof check.result?.latest === 'string' ? check.result.latest : null;
  } catch {
    // The notice is a hint; the Update page shows errors.
  }
});
</script>

<template>
  <v-alert v-if="shown" type="info" variant="tonal" class="mb-4 dm-notice">
    <template #prepend><span class="dm-notice__icon"><v-icon :icon="mdiUpdate" size="20" /></span></template>
    <div class="d-flex flex-wrap align-center ga-3">
      <span>Manager {{ latest }} is available. <router-link to="/update">Open the Update page</router-link>.</span>
      <v-spacer />
      <v-btn variant="text" size="small" @click="preferences.dismissUpdate(latest!)">Dismiss</v-btn>
    </div>
  </v-alert>
</template>

<style scoped>
.dm-notice { border: 1px solid rgba(var(--v-theme-info), 0.28); align-items: center; }
.dm-notice.v-theme--light :deep(.v-alert__underlay) { opacity: 0.07; }
.dm-notice :deep(.v-alert__content) { color: rgba(var(--v-theme-on-surface), 0.9); line-height: 1.5; }
.dm-notice :deep(.v-alert__prepend) { align-self: center; }
.dm-notice__icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: rgba(var(--v-theme-info), 0.16); color: rgb(var(--v-theme-info)); }
.dm-notice a { color: rgb(var(--v-theme-on-surface)); font-weight: 600; text-decoration-color: rgb(var(--v-theme-info)); text-decoration-thickness: 2px; text-underline-offset: 3px; }
</style>
