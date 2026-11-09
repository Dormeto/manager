<script setup lang="ts">
// Choose hibernation for a router or a workload: Inherit (the level above decides), On or Off. `inheritable` false hides
// Inherit (the global level has nothing above it).
import { ref, watch } from 'vue';
import { mdiPowerSleep } from '@mdi/js';

type Choice = 'inherit' | 'on' | 'off';
const props = withDefaults(defineProps<{ modelValue: boolean; subject: string; current: boolean | null; inheritable?: boolean; inheritText?: string; saving?: boolean; cloud?: 'aws' | 'gcp' }>(), { inheritable: true, inheritText: '', saving: false, cloud: 'aws' });
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [boolean | null] }>();
const choice = ref<Choice>('inherit');
const choiceOf = (value: boolean | null): Choice => (value === null ? (props.inheritable ? 'inherit' : 'on') : value ? 'on' : 'off');
watch(() => props.modelValue, (open) => { if (open) choice.value = choiceOf(props.current); });
const value = (): boolean | null => (choice.value === 'inherit' ? null : choice.value === 'on');
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="480" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="cloud === 'gcp' ? `Suspend instead of stop ${subject}` : `Hibernate ${subject}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiPowerSleep" size="20" /></v-avatar></template>
      <v-card-text>
        <p v-if="cloud === 'gcp'" class="mb-4 text-medium-emphasis">Decides whether the VMs of the workload are suspended instead of stopped when it naps: a suspended VM keeps its memory
          and resumes faster. A VM that cannot be suspended (with a GPU or a TPU, confidential, or with more than 208 GB of memory) is stopped. After 60 days Compute Engine stops a suspended
          VM itself. A workload with fallback machine types is not suspended unless it is set to On on the workload itself.</p>
        <p v-else class="mb-4 text-medium-emphasis">Decides whether the standalone EC2 instances (not Auto Scaling groups or ECS) that were launched with hibernation are
          hibernated instead of stopped when the workload naps. Dormeto does not enable hibernation on an instance: it is chosen when the instance is launched.
          A workload with fallback instance types does not hibernate unless it is set to On on the workload itself.</p>
        <v-radio-group v-model="choice" hide-details>
          <v-radio v-if="inheritable" value="inherit" :label="inheritText ? `Inherit (${inheritText})` : 'Inherit'" />
          <v-radio value="on" label="On" />
          <v-radio value="off" label="Off" />
        </v-radio-group>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="emit('submit', value())">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
