<script setup lang="ts">
// The discounts for commitments (R9.5): whole percentages off the list prices, compute (EC2, Fargate) and databases (RDS,
// Aurora), never off Spot. An average rate: a nap saves the list price of what goes beyond a commitment, nothing within.
import { ref, watch } from 'vue';
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
    <v-card title="Discounts for commitments">
      <v-card-text>
        <p class="mb-2">What Savings Plans, Reserved Instances or your AWS agreement take off the list prices, on average. Spot is
          priced at Spot prices, without discount.</p>
        <p class="mb-4 text-medium-emphasis">Under a commitment, a nap saves the list price of what goes beyond it and nothing of what
          stays within it: set an average rate, not an exact figure. A change applies from the next day computed; the days
          already computed keep theirs.</p>
        <v-text-field v-model="compute" data-test="compute" label="Compute: EC2 and Fargate" suffix="%" inputmode="numeric" :rules="[percent]" autofocus />
        <v-text-field v-model="databases" data-test="databases" label="Databases: RDS and Aurora" suffix="%" inputmode="numeric" :rules="[percent]" @keyup.enter="submit" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!valid()" @click="submit">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
