<script setup lang="ts">
// The confirmation before a router's uninstallation (its row's menu in Routers, its own view's button).
import { mdiDeleteOutline } from '@mdi/js';

defineProps<{ modelValue: boolean; subject: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; confirm: [] }>();
function confirm() {
  emit('update:modelValue', false);
  emit('confirm');
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="460" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Uninstall ${subject}?`">
      <template #prepend>
        <v-avatar color="error" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiDeleteOutline" size="20" /></v-avatar>
      </template>
      <v-card-text class="text-medium-emphasis">Every resource of the router is deleted. Refused while it has workloads: offboard them first.</v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="error" variant="flat" @click="confirm">Uninstall</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
