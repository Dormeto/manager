<script setup lang="ts">
// A notice as a toast: a success for a few seconds, an error until closed; an operation it announces links to its steps.
import type { Notice } from './NoticeAlert.vue';

defineProps<{ notice: Notice | null }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <v-snackbar :key="notice ? `${notice.text}${notice.operation ?? ''}` : ''" :model-value="notice !== null" :color="notice?.type"
    :timeout="notice?.type === 'error' ? -1 : 8000" location="bottom end" multi-line @update:model-value="(open: boolean) => open || emit('close')">
    <template v-if="notice">
      {{ notice.text }}
      <router-link v-if="notice.operation" :to="{ path: '/operations', query: { id: notice.operation } }">Follow it in Operations</router-link>
    </template>
    <template #actions>
      <v-btn variant="text" @click="emit('close')">Close</v-btn>
    </template>
  </v-snackbar>
</template>

<style scoped>
.v-snackbar a { color: inherit; font-weight: 600; }
</style>
