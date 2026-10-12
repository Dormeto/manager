import { onMounted, onUnmounted, ref } from 'vue';

// Runs `load` now and every `ms` while the page is visible; exposes loading, error and the last refresh time.
export function usePoll(load: () => Promise<void>, ms: number) {
  const loading = ref(false);
  const error = ref('');
  const refreshedAt = ref<number | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function run() {
    if (document.hidden || loading.value) return;
    loading.value = true;
    try {
      await load();
      error.value = '';
      refreshedAt.value = Date.now();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    void run();
    timer = setInterval(run, ms);
  });
  onUnmounted(() => clearInterval(timer));
  return { loading, error, refreshedAt, run };
}
