<script setup lang="ts">
// What a discovery status means, the actions that leave it, and what changes it by itself (tooltip content); untitled:
// without its name, which the tooltip already starts with (a status mark's).
import type { Status } from '@dormeto/discovery/types';
import { statusChanges, statusHelp, statusLabel, statusTransitions } from '../discovery';

defineProps<{ status: Status; untitled?: boolean }>();
</script>

<template>
  <div v-if="!untitled" class="font-weight-bold">{{ statusLabel(status) }}</div>
  <div>{{ statusHelp(status) }}</div>
  <ul v-if="statusTransitions(status).length" class="transitions mt-1">
    <li v-for="t in statusTransitions(status)" :key="t.action">{{ t.action }} → {{ t.to }}</li>
  </ul>
  <div v-if="statusChanges(status)" class="mt-1 note">{{ statusChanges(status) }}</div>
</template>

<style scoped>
.transitions { padding-left: 1.1em; }
.transitions li::marker { color: rgb(var(--v-theme-secondary)); }
.note { opacity: 0.8; }
</style>
