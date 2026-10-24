<script setup lang="ts">
// The defaults every workload inherits, set in the manager's settings (the routers read them within 5 minutes): for now,
// hibernation. Everyone reads it; administrators change it, after a confirmation that says what it affects.
import { ref } from 'vue';
import { mdiCogOutline } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useNow } from '../now';
import { useSession } from '../stores/session';
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
  <v-card data-test="workload-defaults" class="mt-6">
    <v-card-item>
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiCogOutline" size="19" /></v-avatar></template>
      <v-card-title>Workload defaults</v-card-title>
    </v-card-item>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <v-card-text v-else-if="defaults" class="d-flex flex-wrap align-center ga-4">
      <div>
        <div class="font-weight-medium">Hibernate</div>
        <div class="text-body-small text-medium-emphasis">Whether standalone EC2 instances (not Auto Scaling groups or ECS) that were launched with hibernation are hibernated instead of stopped when a workload naps; a router or a workload can override this (a workload with fallback instance types hibernates only if set On on itself).
          {{ defaults.updatedAt ? `Changed by ${defaults.updatedBy ?? 'someone'} ${relative(defaults.updatedAt, now)}.` : 'Never changed.' }}</div>
      </div>
      <v-spacer />
      <v-switch v-if="session.isAdmin" :key="switchKey" :model-value="defaults.hibernate" :label="defaults.hibernate ? 'On' : 'Off'" color="primary" hide-details inset aria-label="Hibernate by default"
        @update:model-value="asked = Boolean($event)" />
      <v-chip v-else label variant="tonal" :color="defaults.hibernate ? 'primary' : undefined">{{ defaults.hibernate ? 'On' : 'Off' }}</v-chip>
    </v-card-text>
  </v-card>
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
