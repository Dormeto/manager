<script setup lang="ts">
// A notice above a view; an operation it announces links to its steps in the Operations view.
export interface Notice {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
  operation?: string;
}
defineProps<{ notice: Notice }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <v-alert :type="notice.type" closable class="mb-4 notice" @click:close="$emit('close')">
    {{ notice.text }}
    <router-link v-if="notice.operation" :to="{ path: '/operations', query: { id: notice.operation } }">Follow it in Operations</router-link>
  </v-alert>
</template>

<style scoped>
.notice a { color: inherit; font-weight: 600; }
</style>
