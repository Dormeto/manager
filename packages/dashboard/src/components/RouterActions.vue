<script setup lang="ts">
// A router's actions on its own view: uninstall (administrators, routers the manager installed, after a confirmation), pause
// with a reason and resume (operators). The parent runs them (router-operations.ts). Routers has them in each row's menu.
import { ref } from 'vue';
import { mdiDeleteOutline, mdiPause, mdiPlay } from '@mdi/js';
import { pauseHelp, resumeHelp, uninstallHelp } from '../router-actions';
import { useSession } from '../stores/session';
import PauseDialog from './PauseDialog.vue';
import UninstallDialog from './UninstallDialog.vue';
import type { RouterInfo } from '../types';

defineProps<{ router: RouterInfo }>();
const emit = defineEmits<{ uninstall: []; pause: [{ reason: string; until?: string; keepAsleep: boolean }]; resume: [] }>();
const session = useSession();
const removing = ref(false);
const pausing = ref(false);
</script>

<template>
  <div class="dm-router-actions d-flex flex-nowrap align-center justify-end ga-1">
    <template v-if="session.isAdmin && router.source === 'manager'">
      <v-tooltip location="top" max-width="380" :text="uninstallHelp(router.name)">
        <template #activator="{ props }">
          <v-btn v-bind="props" :icon="mdiDeleteOutline" variant="text" size="small" class="dm-router-actions__remove" :aria-label="`Uninstall ${router.name}`" @click="removing = true" />
        </template>
      </v-tooltip>
    </template>
    <template v-if="session.canOperate && router.health">
      <v-tooltip location="top" max-width="380" :text="router.pauses?.length ? resumeHelp(router.name) : pauseHelp(router.name)">
        <template #activator="{ props }">
          <v-btn v-if="router.pauses?.length" v-bind="props" :prepend-icon="mdiPlay" variant="tonal" color="secondary" size="small" @click="emit('resume')">Resume</v-btn>
          <v-btn v-else v-bind="props" :prepend-icon="mdiPause" variant="tonal" size="small" @click="pausing = true">Pause</v-btn>
        </template>
      </v-tooltip>
    </template>
  </div>
  <UninstallDialog v-model="removing" :subject="router.name" @confirm="emit('uninstall')" />
  <PauseDialog v-model="pausing" :subject="router.name" router @submit="pausing = false; emit('pause', $event)" />
</template>

<style scoped>
.dm-router-actions__remove { opacity: 0.7; transition: opacity 0.2s, color 0.2s; }
.dm-router-actions__remove:hover, .dm-router-actions__remove:focus-visible { opacity: 1; color: rgb(var(--v-theme-error)); }
</style>
