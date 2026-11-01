<script setup lang="ts">
// The defaults every workload inherits, set in the manager's settings (the routers read them within 5 minutes): hibernation and
// joined windows. Everyone reads them; administrators change them, after a dialog that says what it affects.
import { ref } from 'vue';
import { mdiCogOutline, mdiPencilOutline } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useNow } from '../now';
import { JOIN_DEFAULT_MINUTES, joinText } from '../schedule';
import { useSession } from '../stores/session';
import JoinDialog from './JoinDialog.vue';
import type { WorkloadDefaults } from '../types';
import type { Notice } from './NoticeAlert.vue';

const emit = defineEmits<{ notice: [Notice] }>();
const now = useNow();
const session = useSession();
const defaults = ref<WorkloadDefaults | null>(null);
const error = ref('');
// The value the switch asks for, until the administrator confirms or cancels.
const asked = ref<boolean | null>(null);
const saving = ref(false);
// The switch flips as it is clicked: a new key puts it back on the stored value when the confirmation is cancelled.
const switchKey = ref(0);
const cancel = () => { asked.value = null; switchKey.value += 1; };

// Joined windows: the value set, or the built-in one while none is. Only this key is sent: the file keeps hibernate.
const joinOpen = ref(false);
const savingJoin = ref(false);
const joinLine = () => (defaults.value?.joinMinutes ?? null) === null ? joinText({ joinMinutes: JOIN_DEFAULT_MINUTES, joinFrom: 'default' }) : `${defaults.value!.joinMinutes} min`;
async function saveJoin(joinMinutes: number | null) {
  savingJoin.value = true;
  try {
    const saved = await api<WorkloadDefaults & { note: string }>('/settings/workloads', { method: 'PUT', body: JSON.stringify({ joinMinutes }) });
    defaults.value = saved;
    emit('notice', { type: 'success', text: `Windows of one kind join up to ${joinMinutes ?? JOIN_DEFAULT_MINUTES} minutes apart by default: ${saved.note}.` });
  } catch (err) {
    emit('notice', { type: 'error', text: (err as Error).message });
  } finally {
    savingJoin.value = false;
    joinOpen.value = false;
  }
}

async function load() {
  try {
    defaults.value = await api<WorkloadDefaults>('/settings/workloads');
  } catch (err) {
    error.value = (err as Error).message;
  }
}
void load();

async function confirm() {
  const hibernate = asked.value!;
  saving.value = true;
  try {
    const saved = await api<WorkloadDefaults & { note: string }>('/settings/workloads', { method: 'PUT', body: JSON.stringify({ hibernate }) });
    defaults.value = saved;
    emit('notice', { type: 'success', text: `Hibernation is ${hibernate ? 'on' : 'off'} by default: ${saved.note}.` });
  } catch (err) {
    switchKey.value += 1;
    emit('notice', { type: 'error', text: (err as Error).message });
  } finally {
    saving.value = false;
    asked.value = null;
  }
}
</script>

<template>
  <v-card data-test="workload-defaults">
    <v-card-item>
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiCogOutline" size="19" /></v-avatar></template>
      <v-card-title>Workload defaults</v-card-title>
    </v-card-item>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <template v-else-if="defaults">
    <v-card-text class="d-flex flex-wrap align-center ga-4 pb-2">
      <div class="dm-default">
        <div class="font-weight-medium">Hibernate</div>
        <div class="text-body-small text-medium-emphasis">Whether standalone EC2 instances (not Auto Scaling groups or ECS) that were launched with hibernation are hibernated instead of stopped when a workload naps; a router or a workload can override this (a workload with fallback instance types hibernates only if set On on itself).</div>
      </div>
      <v-spacer />
      <v-switch v-if="session.isAdmin" :key="switchKey" :model-value="defaults.hibernate" :label="defaults.hibernate ? 'On' : 'Off'" color="primary" hide-details inset aria-label="Hibernate by default"
        @update:model-value="asked = Boolean($event)" />
      <v-chip v-else label variant="tonal" :color="defaults.hibernate ? 'primary' : undefined">{{ defaults.hibernate ? 'On' : 'Off' }}</v-chip>
    </v-card-text>
    <v-card-text data-test="default-join" class="d-flex flex-wrap align-center ga-4 py-2">
      <div class="dm-default">
        <div class="font-weight-medium">Join windows</div>
        <div class="text-body-small text-medium-emphasis">Two windows of one kind with a gap of at most this count as one, so a workload is neither woken nor napped for the gap; 0 never joins. A router or a workload can override this.</div>
      </div>
      <v-spacer />
      <span data-test="default-join-value" class="dm-num">{{ joinLine() }}</span>
      <v-btn v-if="session.isAdmin" data-test="edit-join" :prepend-icon="mdiPencilOutline" variant="text" size="small" @click="joinOpen = true">Edit</v-btn>
    </v-card-text>
    <v-card-text class="pt-0 text-body-small text-medium-emphasis">{{ defaults.updatedAt ? `Changed by ${defaults.updatedBy ?? 'someone'} ${relative(defaults.updatedAt, now)}.` : 'Never changed.' }}</v-card-text>
    </template>
  </v-card>
  <JoinDialog v-if="defaults" v-model="joinOpen" title="Join windows by default" :current="defaults.joinMinutes ?? null" :inherited="JOIN_DEFAULT_MINUTES" :inherit-label="`Default (${JOIN_DEFAULT_MINUTES} min)`" :saving="savingJoin" @submit="saveJoin">
    Two windows of one kind with a gap of at most this count as one. It applies in every router that reads the manager's settings, within 5 minutes; a router or a workload that sets its own value keeps it.
  </JoinDialog>
  <v-dialog :model-value="asked !== null" max-width="480" @update:model-value="cancel">
    <v-card :title="`Turn hibernation ${asked ? 'on' : 'off'} by default?`">
      <v-card-text class="text-medium-emphasis">It applies to standalone EC2 instances (not Auto Scaling groups or ECS) launched with hibernation, in every router that
        reads the manager's settings, from their next check (within 5 minutes). A router or a workload that sets its own value keeps it. Dormeto does not enable
        hibernation on an instance: it is chosen when the instance is launched.</v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="cancel">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="confirm">{{ asked ? 'Turn on' : 'Turn off' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
/* The text beside its control: it wraps above the control only when the card has no room. */
.dm-default { flex: 1 1 320px; min-width: 0; }
.dm-num { font-variant-numeric: tabular-nums; }
</style>
