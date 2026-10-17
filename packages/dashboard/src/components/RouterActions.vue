<script setup lang="ts">
// A router's actions: uninstall (administrators, routers the manager installed, after a confirmation), pause with a reason
// and resume (operators). The parent runs them (router-operations.ts).
import { ref } from 'vue';
import { mdiDeleteOutline, mdiPause, mdiPlay } from '@mdi/js';
import { pauseHelp, resumeHelp, uninstallHelp } from '../router-actions';
import { useSession } from '../stores/session';
import PauseDialog from './PauseDialog.vue';
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
  <v-dialog v-model="removing" max-width="460">
    <v-card :title="`Uninstall ${router.name}?`">
      <template #prepend>
        <v-avatar color="error" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiDeleteOutline" size="20" /></v-avatar>
      </template>
      <v-card-text class="text-medium-emphasis">Every resource of the router is deleted. Refused while it has workloads: offboard them first.</v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="removing = false">Cancel</v-btn>
        <v-btn color="error" variant="flat" @click="removing = false; emit('uninstall')">Uninstall</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <PauseDialog v-model="pausing" :subject="router.name" router @submit="pausing = false; emit('pause', $event)" />
</template>

<style scoped>
.dm-router-actions__remove { opacity: 0.7; transition: opacity 0.2s, color 0.2s; }
.dm-router-actions__remove:hover, .dm-router-actions__remove:focus-visible { opacity: 1; color: rgb(var(--v-theme-error)); }
</style>
