import { onMounted, onUnmounted, ref, watch } from 'vue';
import { usePreferences } from './stores/preferences';

// Runs `load` now, then every refresh interval of the user's preferences (0 = only on demand) while the page is
// visible; exposes loading, error, the last refresh time and the time of the next one (for the countdown).
export function usePoll(load: () => Promise<void>) {
  const preferences = usePreferences();
  const loading = ref(false);
  const error = ref('');
  const refreshedAt = ref<number | null>(null);
  const nextAt = ref<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;

  function schedule() {
    clearTimeout(timer);
    const seconds = preferences.refreshSeconds;
    nextAt.value = seconds > 0 && active ? Date.now() + seconds * 1000 : null;
    if (nextAt.value) timer = setTimeout(() => void run(), seconds * 1000);
  }

  async function run() {
    if (loading.value) return;
    if (document.hidden) {
      schedule();
      return;
    }
    loading.value = true;
    try {
      await load();
      error.value = '';
      refreshedAt.value = Date.now();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
      schedule();
    }
  }

  watch(() => preferences.refreshSeconds, schedule);
  onMounted(() => void run());
  onUnmounted(() => {
    active = false;
    clearTimeout(timer);
  });
  return { loading, error, refreshedAt, nextAt, run };
}
