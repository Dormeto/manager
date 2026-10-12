<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeSignIn } from '../auth';

const router = useRouter();
const error = ref('');

onMounted(async () => {
  try {
    await router.replace(await completeSignIn());
  } catch (err) {
    error.value = (err as Error).message;
  }
});
</script>

<template>
  <v-alert v-if="error" type="error" title="Sign-in failed" :text="error">
    <template #append><v-btn variant="text" href="/">Try again</v-btn></template>
  </v-alert>
  <div v-else class="d-flex justify-center pa-12"><v-progress-circular indeterminate color="primary" /></div>
</template>
