<script setup lang="ts">
// Lint findings of the perimeter configuration: warnings (useless inclusions) and information (no match in the last run).
import { computed } from 'vue';
import { mdiArrowRight } from '@mdi/js';
import type { LintFinding } from '@dormeto/discovery/types';

const props = defineProps<{ findings: LintFinding[]; settingsLink?: boolean }>();
const warnings = computed(() => props.findings.filter((f) => f.level === 'warning'));
</script>

<template>
  <v-alert v-if="findings.length" :type="warnings.length ? 'warning' : 'info'" variant="tonal" class="dm-lint mb-4" density="compact">
    <div class="dm-lint__title">{{ warnings.length ? 'Some inclusions of the perimeter are useless' : 'Perimeter notes' }}</div>
    <ul class="dm-lint__list">
      <li v-for="(f, i) in findings" :key="i" class="text-body-medium">{{ f.message }}</li>
    </ul>
    <router-link v-if="settingsLink" to="/discovery/settings" class="dm-lint__link">Edit the perimeter<v-icon :icon="mdiArrowRight" size="14" /></router-link>
  </v-alert>
</template>

<style scoped>
.dm-lint { padding-block: 12px !important; }
.dm-lint__title { margin-bottom: 4px; font-weight: 600; letter-spacing: -0.01em; }
.dm-lint__list { display: grid; gap: 2px; margin: 0; padding-left: 1.1em; }
.dm-lint__link { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; color: inherit; font-size: 0.82rem; font-weight: 600; text-decoration: none; }
.dm-lint__link:hover, .dm-lint__link:focus-visible { text-decoration: underline; }
.dm-lint__link .v-icon { transition: transform 0.2s var(--dm-ease); }
.dm-lint__link:hover .v-icon { transform: translateX(2px); }
@media (prefers-reduced-motion: reduce) { .dm-lint__link .v-icon { transition: none; } }
</style>
