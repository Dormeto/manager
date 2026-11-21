<script setup lang="ts">
// The Kind filter of Workloads and Discovery: each kind with its icon (kinds.ts), in the list and in the selected value;
// cleared, every kind.
import { KINDS, kindInfo, type Kind } from '../kinds';

defineProps<{ modelValue: Kind | null }>();
const emit = defineEmits<{ 'update:modelValue': [kind: Kind | null] }>();
</script>

<template>
  <v-select :model-value="modelValue" :items="KINDS" item-title="short" item-value="value" label="Kind" clearable density="compact" hide-details
    data-test="kind-filter" @update:model-value="emit('update:modelValue', ($event ?? null) as Kind | null)">
    <template #item="{ props: item, item: choice }">
      <v-list-item v-bind="item" data-test="kind-item">
        <template #prepend><v-icon :icon="kindInfo((choice as unknown as { value: Kind }).value).icon" size="18" /></template>
      </v-list-item>
    </template>
    <template #selection="{ item: choice }">
      <span class="dm-kind-choice">
        <v-icon data-test="kind-selected" :icon="kindInfo((choice as unknown as { value: Kind }).value).icon" size="16" role="img" :aria-label="kindInfo((choice as unknown as { value: Kind }).value).short" :aria-hidden="false" />
        {{ kindInfo((choice as unknown as { value: Kind }).value).short }}
      </span>
    </template>
  </v-select>
</template>

<style scoped>
.dm-kind-choice { display: inline-flex; align-items: center; gap: 6px; }
</style>
