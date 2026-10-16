<script setup lang="ts">
// A region as its country's flag; its AWS location, country and code in a tooltip.
import { computed } from 'vue';
import { mdiEarth } from '@mdi/js';
import { regionInfo } from '../regions';

const props = defineProps<{ region: string }>();
const info = computed(() => regionInfo(props.region));
</script>

<template>
  <v-tooltip location="top">
    <template #activator="{ props: tip }">
      <span v-bind="tip" class="region-label d-inline-flex align-center" tabindex="0" :aria-label="[region, info.location].filter(Boolean).join(', ')">
        <img v-if="info.flag" :src="info.flag" alt="" class="flag">
        <v-icon v-else :icon="mdiEarth" size="1.2em" />
      </span>
    </template>
    <div v-if="info.location" class="font-weight-bold">{{ info.location }}</div>
    <div>{{ info.country ? `${info.country} · ${region}` : `${region}: a region Dormeto does not know yet` }}</div>
  </v-tooltip>
</template>

<style scoped>
.region-label { line-height: 1; border-radius: 4px; vertical-align: -0.12em; }
.region-label:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
/* 4:3, sized with the text around it (table cell or caption); a faint ring and sheen so light flags hold on glass. */
.flag { flex: none; height: 1em; width: calc(4em / 3); border-radius: 3px; object-fit: cover;
  box-shadow: 0 0 0 1px rgba(var(--v-border-color), 0.22), 0 1px 3px rgba(var(--v-theme-on-surface), 0.12); }
</style>
