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
  <div class="d-flex flex-nowrap align-center justify-end ga-1">
    <template v-if="session.isAdmin && router.source === 'manager'">
      <v-tooltip location="top" max-width="380" :text="uninstallHelp(router.name)">
        <template #activator="{ props }">
          <v-btn v-bind="props" :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Uninstall ${router.name}`" @click="removing = true" />
        </template>
      </v-tooltip>
    </template>
    <template v-if="session.canOperate && router.health">
      <v-tooltip location="top" max-width="380" :text="router.pauses?.length ? resumeHelp(router.name) : pauseHelp(router.name)">
        <template #activator="{ props }">
          <v-btn v-if="router.pauses?.length" v-bind="props" :prepend-icon="mdiPlay" variant="tonal" size="small" @click="emit('resume')">Resume</v-btn>
          <v-btn v-else v-bind="props" :prepend-icon="mdiPause" variant="tonal" size="small" @click="pausing = true">Pause</v-btn>
        </template>
      </v-tooltip>
    </template>
  </div>
  <v-dialog v-model="removing" max-width="460">
    <v-card :title="`Uninstall ${router.name}?`">
      <v-card-text>Every resource of the router is deleted. Refused while it has workloads: offboard them first.</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="removing = false">Cancel</v-btn>
        <v-btn color="error" variant="flat" @click="removing = false; emit('uninstall')">Uninstall</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  <PauseDialog v-model="pausing" :subject="router.name" router @submit="pausing = false; emit('pause', $event)" />
</template>
