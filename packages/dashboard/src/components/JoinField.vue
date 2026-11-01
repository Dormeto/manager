<script setup lang="ts">
// How far apart two windows of one kind may be and still count as one, at a level: its own value or what the level above gives
// (`inherited`, said by `inheritLabel`). null inherits; NaN is the field left blank, refused in the router's words as any other.
import { computed } from 'vue';
import { JOIN_MINUTES_MAX, JOIN_PROBLEM, isJoinMinutes } from '../schedule';

const props = defineProps<{ modelValue: number | null; inherited: number; inheritLabel: string }>();
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();
const inherit = computed(() => props.modelValue === null);
const shown = computed(() => (props.modelValue === null ? props.inherited : Number.isNaN(props.modelValue) ? '' : props.modelValue));
const problem = computed(() => (inherit.value || isJoinMinutes(props.modelValue) ? '' : JOIN_PROBLEM));
const typed = (value: unknown) => emit('update:modelValue', value === '' || value === null || value === undefined ? NaN : Number(value));
</script>

<template>
  <div data-test="join" class="dm-join">
    <div class="dm-join__row">
      <span class="dm-join__words">Join windows of one kind up to
        <v-text-field :model-value="shown" :disabled="inherit" type="number" min="0" :max="JOIN_MINUTES_MAX" step="5" density="compact" hide-details aria-label="The largest gap that joins, in minutes" class="dm-join__minutes" @update:model-value="typed" />
        minutes apart</span>
      <v-checkbox :model-value="inherit" :label="inheritLabel" density="compact" hide-details class="dm-join__inherit" @update:model-value="emit('update:modelValue', $event ? null : inherited)" />
    </div>
    <div v-if="problem" data-test="join-problem" class="text-body-small text-error">{{ problem }}</div>
    <div v-else class="text-body-small text-medium-emphasis">So the gap neither wakes nor naps it; 0 never joins.</div>
  </div>
</template>

<style scoped>
.dm-join__row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 16px; }
.dm-join__words { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.dm-join__minutes { flex: 0 0 84px; width: 84px; }
.dm-join__inherit { flex: 0 1 auto; }
</style>
