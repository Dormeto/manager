<script setup lang="ts">
// A notice as a toast: a success for a few seconds, an error until closed; an operation it announces links to its steps.
import { mdiAlertCircleOutline, mdiAlertOutline, mdiCheckCircleOutline, mdiInformationOutline } from '@mdi/js';
import type { Notice } from './NoticeAlert.vue';

defineProps<{ notice: Notice | null }>();
const emit = defineEmits<{ close: [] }>();
const ICONS = { success: mdiCheckCircleOutline, error: mdiAlertCircleOutline, info: mdiInformationOutline, warning: mdiAlertOutline };
</script>

<template>
  <v-snackbar :key="notice ? `${notice.text}${notice.operation ?? ''}` : ''" :model-value="notice !== null" :class="['dm-toast', notice && `dm-toast--${notice.type}`]"
    :timeout="notice?.type === 'error' ? -1 : 8000" :timer="notice?.type === 'error' ? false : 'bottom'" :timer-color="notice?.type" rounded="xl"
    location="bottom end" multi-line @update:model-value="(open: boolean) => open || emit('close')">
    <template v-if="notice" #prepend><span class="dm-toast__icon"><v-icon :icon="ICONS[notice.type]" size="20" /></span></template>
    <template v-if="notice">
      {{ notice.text }}
      <router-link v-if="notice.operation" :to="{ path: '/operations', query: { id: notice.operation } }">Follow it in Operations</router-link>
    </template>
    <template #actions>
      <v-btn variant="text" @click="emit('close')">Close</v-btn>
    </template>
  </v-snackbar>
</template>

<style>
/* The toast: a glass card of the theme, its type's color on the icon, the border and the timer only. */
.dm-toast { --tone: var(--v-theme-info); }
.dm-toast--success { --tone: var(--v-theme-success); }
.dm-toast--error { --tone: var(--v-theme-error); }
.dm-toast--warning { --tone: var(--v-theme-warning); }
.dm-toast .v-snackbar__wrapper { background: rgba(var(--v-theme-surface), 0.94) !important; color: rgb(var(--v-theme-on-surface)) !important;
  border: 1px solid rgba(var(--tone), 0.32); backdrop-filter: blur(18px); box-shadow: 0 24px 50px -24px rgba(0, 0, 0, 0.6) !important; overflow: hidden; }
.dm-toast .v-snackbar__prepend { margin-inline-start: 14px; }
.dm-toast .v-snackbar__content { line-height: 1.5; }
.dm-toast .v-snackbar__content a { color: rgb(var(--v-theme-on-surface)); font-weight: 600; text-decoration-color: rgb(var(--tone)); text-decoration-thickness: 2px; text-underline-offset: 3px; margin-left: 4px; }
.dm-toast__icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: rgba(var(--tone), 0.16); color: rgb(var(--tone)); }
</style>
