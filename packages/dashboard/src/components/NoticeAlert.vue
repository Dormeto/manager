<script setup lang="ts">
// A notice above a view; an operation it announces links to its steps in the Operations view.
import { computed } from 'vue';
import { mdiAlertCircleOutline, mdiAlertOutline, mdiCheckCircleOutline, mdiInformationOutline } from '@mdi/js';

export interface Notice {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
  operation?: string;
}
const props = defineProps<{ notice: Notice }>();
defineEmits<{ close: [] }>();
const ICONS = { success: mdiCheckCircleOutline, error: mdiAlertCircleOutline, info: mdiInformationOutline, warning: mdiAlertOutline };
const icon = computed(() => ICONS[props.notice.type]);
</script>

<template>
  <v-alert :type="notice.type" variant="tonal" closable class="mb-4 notice" :class="`notice--${notice.type}`" @click:close="$emit('close')">
    <template #prepend><span class="notice__icon"><v-icon :icon="icon" size="20" /></span></template>
    {{ notice.text }}
    <router-link v-if="notice.operation" :to="{ path: '/operations', query: { id: notice.operation } }">Follow it in Operations</router-link>
  </v-alert>
</template>

<style scoped>
.notice { --tone: var(--v-theme-info); border: 1px solid rgba(var(--tone), 0.28); align-items: center; animation: notice-in 0.45s var(--dm-ease) both; }
.notice--success { --tone: var(--v-theme-success); }
.notice--error { --tone: var(--v-theme-error); }
.notice--warning { --tone: var(--v-theme-warning); }
.notice.v-theme--light :deep(.v-alert__underlay) { opacity: 0.07; }
.notice :deep(.v-alert__content) { color: rgba(var(--v-theme-on-surface), 0.9); line-height: 1.5; }
.notice :deep(.v-alert__prepend), .notice :deep(.v-alert__close) { align-self: center; }
.notice__icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: rgba(var(--tone), 0.16); color: rgb(var(--tone)); }
.notice a { color: rgb(var(--v-theme-on-surface)); font-weight: 600; text-decoration-color: rgb(var(--tone)); text-decoration-thickness: 2px; text-underline-offset: 3px; margin-left: 4px; white-space: nowrap; }
@keyframes notice-in { from { opacity: 0; transform: translateY(-6px); } }
@media (prefers-reduced-motion: reduce) { .notice { animation: none; } }
</style>
