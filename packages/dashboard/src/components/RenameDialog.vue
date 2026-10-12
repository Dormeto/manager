<script setup lang="ts">
// Rename a workload: the name is for people only (never in an AWS name, tag or key); duplicates are accepted.
import { ref, watch } from 'vue';
import { nameRule } from '../format';

const props = defineProps<{ modelValue: boolean; name: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [string] }>();
const name = ref('');
watch(() => props.modelValue, (open) => { if (open) name.value = props.name; });
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="460" @update:model-value="emit('update:modelValue', $event)">
    <v-card title="Rename the workload">
      <v-card-text>
        <p class="mb-4">The name shown in the manager and on the router's admin page. Nothing changes in AWS.</p>
        <v-text-field v-model="name" label="Name" :rules="[nameRule]" counter="64" autofocus @keyup.enter="nameRule(name) === true && emit('submit', name.trim())" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="nameRule(name) !== true || !name.trim()" @click="emit('submit', name.trim())">Rename</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
