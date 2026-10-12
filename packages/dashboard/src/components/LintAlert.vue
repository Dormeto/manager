<script setup lang="ts">
// Lint findings of the perimeter configuration: warnings (useless inclusions) and information (no match in the last run).
import { computed } from 'vue';
import type { LintFinding } from '@dormeto/discovery/types';

const props = defineProps<{ findings: LintFinding[]; settingsLink?: boolean }>();
const warnings = computed(() => props.findings.filter((f) => f.level === 'warning'));
</script>

<template>
  <v-alert v-if="findings.length" :type="warnings.length ? 'warning' : 'info'" variant="tonal" class="mb-4" density="compact">
    <div class="font-weight-medium mb-1">{{ warnings.length ? 'Some inclusions of the perimeter are useless' : 'Perimeter notes' }}</div>
    <ul class="pl-4">
      <li v-for="(f, i) in findings" :key="i" class="text-body-medium">{{ f.message }}</li>
    </ul>
    <router-link v-if="settingsLink" to="/discovery/settings" class="text-body-small">Edit the perimeter</router-link>
  </v-alert>
</template>
