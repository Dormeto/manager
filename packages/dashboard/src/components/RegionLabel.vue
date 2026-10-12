<script setup lang="ts">
// A region as its country's flag and its code; its AWS location and country in a tooltip.
import { computed } from 'vue';
import { mdiEarth } from '@mdi/js';
import { regionInfo } from '../regions';

const props = defineProps<{ region: string }>();
const info = computed(() => regionInfo(props.region));
</script>

<template>
  <v-tooltip location="top">
    <template #activator="{ props: tip }">
      <span v-bind="tip" class="region-label d-inline-flex align-center ga-2 nowrap" tabindex="0">
        <img v-if="info.flag" :src="info.flag" alt="" class="flag">
        <v-icon v-else :icon="mdiEarth" size="1.2em" />
        <span>{{ region }}</span>
      </span>
    </template>
    <div v-if="info.location" class="font-weight-bold">{{ info.location }}</div>
    <div>{{ info.country ? `${info.country} · ${region}` : `${region}: a region Dormeto does not know yet` }}</div>
  </v-tooltip>
</template>

<style scoped>
/* 4:3, sized with the text around it (table cell or caption). */
.flag { flex: none; height: 1em; width: calc(4em / 3); border-radius: 2px; object-fit: cover; box-shadow: 0 0 0 1px rgba(var(--v-border-color), 0.2); }
</style>
