<script setup lang="ts">
// Pause a router or a workload: reason, automatic resume, keep asleep.
import { ref, watch } from 'vue';
import { mdiPauseCircleOutline } from '@mdi/js';
import { UNTIL_CHOICES, untilFrom, type UntilChoice } from '../pause';

// canWake false (R11): a pause that wakes the workload needs the wake permission, so the caller can only leave it asleep.
const props = withDefaults(defineProps<{ modelValue: boolean; subject: string; router?: boolean; canWake?: boolean }>(), { canWake: true });
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ reason: string; until?: string; keepAsleep: boolean }] }>();
const reason = ref('');
const choice = ref<UntilChoice>('4h');
const date = ref('');
const keepAsleep = ref(false);
watch(() => props.modelValue, (open) => {
  if (!open) return;
  reason.value = '';
  choice.value = '4h';
  date.value = '';
  keepAsleep.value = !props.canWake;
});

function submit() {
  const until = untilFrom(choice.value, Date.now(), date.value);
  emit('submit', { reason: reason.value.trim(), ...(until ? { until } : {}), keepAsleep: keepAsleep.value });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="520" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Pause ${subject}`">
      <template #prepend><v-avatar color="secondary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiPauseCircleOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-5 text-medium-emphasis">{{ router ? 'No workload of this router' : 'This workload' }} is napped while paused. Requests still wake; the instrumentation stays, so resuming is immediate.</p>
        <v-text-field v-model="reason" label="Reason" placeholder="Incident, migration, change freeze, load test…" maxlength="256" counter autofocus />
        <v-select v-model="choice" :items="UNTIL_CHOICES" label="Resume automatically" />
        <v-text-field v-if="choice === 'date'" v-model="date" type="datetime-local" label="Resume at (local time)" />
        <v-checkbox v-model="keepAsleep" :hide-details="canWake" :disabled="!canWake" :messages="canWake ? undefined : 'Waking it needs the wake permission, which your groups do not give.'" :label="router ? 'Leave asleep workloads asleep (else they are woken now)' : 'Leave it asleep if it sleeps (else it is woken now)'" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!reason.trim() || (choice === 'date' && !date)" @click="submit">Pause</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
