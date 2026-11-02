<script setup lang="ts">
// How long after its end a window stays in its schedule, the organization's (the user, 2026-11-02): its days, 0 to keep them, or
// the default (a year). The routers remove what ended longer ago at their checks.
import { computed, ref, watch } from 'vue';
import { mdiCalendarRemove } from '@mdi/js';
import { ENDED_DAYS_DEFAULT, ENDED_PROBLEM, isEndedDays } from '../schedule';

const props = withDefaults(defineProps<{ modelValue: boolean; current: number | null; saving?: boolean }>(), { saving: false });
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [number | null] }>();
// null: the default; NaN: the field left blank.
const value = ref<number | null>(null);
watch(() => props.modelValue, (open) => { if (open) value.value = props.current; });
const inherit = computed(() => value.value === null);
const invalid = computed(() => !inherit.value && !isEndedDays(value.value));
const shown = computed(() => (value.value === null ? ENDED_DAYS_DEFAULT : Number.isNaN(value.value) ? '' : value.value));
const typed = (v: unknown) => { value.value = v === '' || v === null || v === undefined ? NaN : Number(v); };
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card title="Remove ended windows" data-test="ended-dialog">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarRemove" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4 text-medium-emphasis">A window whose end date passed longer ago than this leaves its schedule, with the dates without a window as old. It
          applies in every router that reads the manager's settings, within 5 minutes; 0 keeps them.</p>
        <div class="d-flex flex-wrap align-center ga-4">
          <v-checkbox :model-value="inherit" :label="`Default (${ENDED_DAYS_DEFAULT} days)`" density="compact" hide-details class="flex-grow-0" @update:model-value="value = $event ? null : ENDED_DAYS_DEFAULT" />
          <v-text-field :model-value="shown" :disabled="inherit" type="number" min="0" max="3650" label="Days after its end" density="compact" hide-details class="dm-ended" @update:model-value="typed" />
        </div>
        <div v-if="invalid" data-test="ended-problem" class="text-body-small text-error mt-2">{{ ENDED_PROBLEM }}</div>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="invalid" @click="emit('submit', value)">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-ended { max-width: 200px; }
</style>
