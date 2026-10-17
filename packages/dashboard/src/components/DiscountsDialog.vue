<script setup lang="ts">
// The discounts for commitments (R9.5): whole percentages off the list prices, compute (EC2, Fargate) and databases (RDS,
// Aurora), never off Spot. An average rate: a nap saves the list price of what goes beyond a commitment, nothing within.
import { ref, watch } from 'vue';
import { mdiInformationOutline, mdiPercentOutline } from '@mdi/js';
import type { Discounts } from '../types';

const props = defineProps<{ modelValue: boolean; discounts: Discounts }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Discounts] }>();
const compute = ref('');
const databases = ref('');
watch(() => props.modelValue, (open) => {
  if (open) [compute.value, databases.value] = [String(props.discounts.compute), String(props.discounts.databases)];
});
const percent = (v: string) => (/^\d{1,2}$/.test(v.trim()) && Number(v) <= 90) || 'A whole percentage from 0 to 90';
const valid = () => percent(compute.value) === true && percent(databases.value) === true;
const submit = () => { if (valid()) emit('submit', { compute: Number(compute.value), databases: Number(databases.value) }); };
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="520" @update:model-value="emit('update:modelValue', $event)">
    <v-card title="Discounts for commitments" class="dm-discounts">
      <template #prepend><v-avatar color="secondary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiPercentOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4">What Savings Plans, Reserved Instances or your AWS agreement take off the list prices, on average. Spot is
          priced at Spot prices, without discount.</p>
        <v-text-field v-model="compute" data-test="compute" label="Compute: EC2 and Fargate" suffix="%" inputmode="numeric" :rules="[percent]" autofocus class="dm-discounts__field" />
        <v-text-field v-model="databases" data-test="databases" label="Databases: RDS and Aurora" suffix="%" inputmode="numeric" :rules="[percent]" class="dm-discounts__field" @keyup.enter="submit" />
        <div class="dm-discounts__note text-body-small">
          <v-icon :icon="mdiInformationOutline" size="18" />
          <p class="mb-0">Under a commitment, a nap saves the list price of what goes beyond it and nothing of what
            stays within it: set an average rate, not an exact figure. A change applies from the next day computed; the days
            already computed keep theirs.</p>
        </div>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!valid()" @click="submit">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-discounts__field :deep(input) { font-variant-numeric: tabular-nums; }
.dm-discounts__note { display: flex; gap: 10px; padding: 12px 14px; border-radius: 14px; color: rgba(var(--v-theme-on-surface), 0.72);
  background: rgba(var(--v-theme-on-surface), 0.03); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-discounts__note .v-icon { flex: none; margin-top: 1px; color: rgb(var(--v-theme-primary)); }
</style>
