<script setup lang="ts">
// Set how far apart windows join for a router or the organization: its own value, or what the level above gives. Its slot says what
// it affects.
import { computed, ref, watch } from 'vue';
import { mdiCalendarClock } from '@mdi/js';
import { isJoinMinutes } from '../schedule';
import JoinField from './JoinField.vue';

const props = withDefaults(defineProps<{ modelValue: boolean; title: string; current: number | null; inherited: number; inheritLabel: string; saving?: boolean }>(), { saving: false });
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [number | null] }>();
const value = ref<number | null>(null);
watch(() => props.modelValue, (open) => { if (open) value.value = props.current; });
const invalid = computed(() => value.value !== null && !isJoinMinutes(value.value));
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="title" data-test="join-dialog">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarClock" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4 text-medium-emphasis"><slot /></p>
        <JoinField v-model="value" :inherited="inherited" :inherit-label="inheritLabel" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="invalid" @click="emit('submit', value)">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
