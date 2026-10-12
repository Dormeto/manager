<script setup lang="ts">
import { stateColor } from '../format';

defineProps<{ state: string }>();
</script>

<template>
  <v-chip :color="stateColor(state)" variant="flat" label class="font-weight-medium">{{ state }}</v-chip>
</template>
