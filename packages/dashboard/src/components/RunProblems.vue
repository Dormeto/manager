<script setup lang="ts">
// The last run's problems of every target scanned (the review's I2): what a pair could not read though it was scanned, such as
// the standalone scan without the discovery role's RDS actions, or an idle share CloudWatch did not answer. A failed target
// says its own error in the run's card.
import { computed } from 'vue';
import type { RunTarget } from '@dormeto/discovery/types';

const props = defineProps<{ targets: RunTarget[] }>();
const lines = computed(() => props.targets.filter((t) => t.status !== 'error').flatMap((t) => (t.problems ?? [])
  .map((problem) => ({ key: `${t.account}/${t.region}/${problem}`, text: `${t.account} · ${t.region === '*' ? 'all regions' : t.region}: ${problem}` }))));
</script>

<template>
  <v-alert v-if="lines.length" data-test="run-problems" type="warning" variant="tonal" density="compact" class="mt-4">
    <div class="text-body-medium mb-1">The last run read these accounts and regions without all it should:</div>
    <ul class="dm-run-problems">
      <li v-for="l in lines" :key="l.key" data-test="run-problem" class="text-body-medium">{{ l.text }}</li>
    </ul>
  </v-alert>
</template>

<style scoped>
.dm-run-problems { padding-left: 18px; }
</style>
