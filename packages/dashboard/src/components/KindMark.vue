<script setup lang="ts">
// A workload's kind as an icon, its name and meaning in a tooltip (kinds.ts `mark`) (the Workloads and Discovery rows mark a standalone one).
import { computed } from 'vue';
import type { Cloud } from '@dormeto/fleet/clouds';
import { kindInfo, kindMark, type Kind } from '../kinds';

const props = defineProps<{ kind: Kind; size?: number; cloud?: Cloud | null }>();
const info = computed(() => ({ ...kindInfo(props.kind), mark: kindMark(props.kind, props.cloud) }));
</script>

<template>
  <span class="dm-kind-wrap"><v-tooltip location="top" max-width="380" :text="info.mark">
    <template #activator="{ props: tip }">
      <v-icon v-bind="tip" data-test="kind-mark" :data-kind="kind" :icon="info.icon" :size="size ?? 16" class="dm-kind" tabindex="0" role="img" :aria-label="info.title" :aria-hidden="false" />
    </template>
  </v-tooltip></span>
</template>

<style scoped>
.dm-kind-wrap { display: inline-flex; vertical-align: middle; margin-left: 4px; }
.dm-kind { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); border-radius: 4px; outline: none; }
.dm-kind:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
</style>
