<script setup lang="ts">
// A backend as its AWS service icon and its id; the service, the id and the ARN in a tooltip.
import { computed } from 'vue';
import { backendArn, backendLabel, shortId } from '../format';
import { backendIcon } from '../icons';

const props = defineProps<{ backend: { kind: string; id: string; arn?: string }; account: string; region: string }>();
const icon = computed(() => backendIcon(props.backend.kind));
const arn = computed(() => backendArn(props.backend, props));
</script>

<template>
  <v-tooltip location="top" max-width="560">
    <template #activator="{ props: tip }">
      <span v-bind="tip" class="backend-label d-inline-flex align-center ga-2" tabindex="0">
        <img v-if="icon" :src="icon" :alt="backendLabel(backend.kind)" width="22" height="22" class="backend-icon">
        <span class="mono nowrap">{{ shortId(backend.id) }}</span>
      </span>
    </template>
    <div class="d-flex align-center ga-3">
      <img v-if="icon" :src="icon" alt="" width="36" height="36" class="backend-icon">
      <div>
        <div class="font-weight-bold">{{ backendLabel(backend.kind) }}</div>
        <div class="mono">{{ shortId(backend.id) }}</div>
      </div>
    </div>
    <div v-if="arn" class="mono mt-2 arn">{{ arn }}</div>
  </v-tooltip>
</template>

<style scoped>
.arn { word-break: break-all; }
</style>
