<script setup lang="ts">
// How far apart two windows of one kind may be and still count as one, at a level: its own value or what the level above gives
// (`inherited`, said by `defaultLabel`). null inherits; NaN is the field left blank, refused in the router's words as any other.
// One row (the user, 2026-11-02): the override first, unchecked while the level inherits, the field enabled once checked; what
// joining does is in a tooltip.
import { computed } from 'vue';
import { mdiInformationOutline } from '@mdi/js';
import { JOIN_MINUTES_MAX, JOIN_PROBLEM, isJoinMinutes } from '../schedule';

const props = defineProps<{ modelValue: number | null; inherited: number; defaultLabel: string }>();
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();
const inherit = computed(() => props.modelValue === null);
const shown = computed(() => (props.modelValue === null ? props.inherited : Number.isNaN(props.modelValue) ? '' : props.modelValue));
const problem = computed(() => (inherit.value || isJoinMinutes(props.modelValue) ? '' : JOIN_PROBLEM));
const typed = (value: unknown) => emit('update:modelValue', value === '' || value === null || value === undefined ? NaN : Number(value));
</script>

<template>
  <div data-test="join" class="dm-join">
    <div data-test="join-row" class="dm-join__row">
      <v-checkbox :model-value="!inherit" label="Override default join:" density="compact" hide-details class="dm-join__override" @update:model-value="emit('update:modelValue', $event ? inherited : null)" />
      <span class="dm-join__words">windows of one kind up to
        <v-text-field :model-value="shown" :disabled="inherit" type="number" min="0" :max="JOIN_MINUTES_MAX" step="5" density="compact" hide-details aria-label="The largest gap that joins, in minutes" class="dm-join__minutes" @update:model-value="typed" />
        minutes apart
        <span data-test="join-default" class="text-medium-emphasis">(default: {{ defaultLabel }})</span>
        <v-tooltip location="top" max-width="320" open-on-focus>
          <template #activator="{ props: activator }">
            <v-icon v-bind="activator" data-test="join-more" :icon="mdiInformationOutline" size="16" tabindex="0" aria-label="What joining does" />
          </template>
          <span data-test="join-tip">Two windows of one kind this close read as one, so the gap neither wakes nor naps the workload. 0 never joins.</span>
        </v-tooltip>
      </span>
    </div>
    <div v-if="problem" data-test="join-problem" class="text-body-small text-error">{{ problem }}</div>
  </div>
</template>

<style scoped>
.dm-join__row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; }
.dm-join__words { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.dm-join__minutes { flex: 0 0 84px; width: 84px; }
.dm-join__override { flex: 0 0 auto; }
</style>
