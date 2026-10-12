<script setup lang="ts">
// Onboard a discovered candidate: workload id, idle window, wake mode, companion databases.
import { ref, watch } from 'vue';
import { workloadIdFrom } from '../operations';

const props = defineProps<{ modelValue: boolean; title: string; suggestedId: string | null; routerName: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ workloadId: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[] }] }>();
const workloadId = ref('');
const idleMinutes = ref(15);
const wakeMode = ref('any');
const databases = ref('');
const ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
watch(() => props.modelValue, (open) => {
  if (!open) return;
  workloadId.value = workloadIdFrom(props.suggestedId, props.routerName);
  idleMinutes.value = 15;
  wakeMode.value = 'any';
  databases.value = '';
});
const idRule = (v: string) => (ID.test(v) && v.length <= 32 - props.routerName.length - 1) || `lowercase letters, digits and hyphens, at most ${32 - props.routerName.length - 1} characters`;

function submit() {
  const list = databases.value.split(',').map((d) => d.trim()).filter(Boolean).map((d) => (d.startsWith('cluster:') ? { kind: 'rds-cluster', id: d.slice(8) } : { kind: 'rds-instance', id: d }));
  emit('submit', { workloadId: workloadId.value, settings: { idleMinutes: Number(idleMinutes.value), wakeMode: wakeMode.value }, databases: list });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Onboard ${title}`">
      <v-card-text>
        <p class="mb-4">The router of its account and region (installed first if needed) tags its backends, adds the waker to every rule
          forwarding to its target group (traffic unchanged) and naps it once idle. A failed onboarding is undone.</p>
        <v-text-field v-model="workloadId" label="Workload id" :rules="[idRule]" autofocus />
        <v-text-field v-model.number="idleMinutes" type="number" label="Idle window (minutes)" min="5" max="1440" />
        <v-select v-model="wakeMode" :items="[{ title: 'Any request that passes the filters wakes', value: 'any' }, { title: 'Browser: only the waiter page, the header or a wake rule wakes', value: 'browser' }]" label="Wake mode" />
        <v-text-field v-model="databases" label="Companion databases (optional)" hint="RDS instance identifiers, or cluster:<identifier>, comma separated: stopped after the application, started before it" persistent-hint />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="idRule(workloadId) !== true" @click="submit">Onboard</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
