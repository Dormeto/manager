<script setup lang="ts">
// The mark of a cloud (Material Design Icons' AWS and Google Cloud marks) before an account or a project: its name, and
// what the owner is called there, for a screen reader and a tooltip.
import { computed } from 'vue';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudMark, ownerLabel } from '../format';

const props = defineProps<{ cloud: Cloud }>();
const mark = computed(() => cloudMark(props.cloud));
const text = computed(() => `${mark.value.label} ${ownerLabel(props.cloud).toLowerCase()}`);
</script>

<template>
  <v-icon data-test="cloud-mark" :data-cloud="cloud" :icon="mark.icon" size="1.25em" class="dm-cloud-mark" role="img" :aria-label="text" :title="text" />
</template>

<style scoped>
.dm-cloud-mark { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); vertical-align: -0.2em; }
</style>
