import { onMounted, onUnmounted, ref } from 'vue';

// One clock for every relative time on screen ("12 s ago"): ticks while at least one component uses it.
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export function useNow() {
  onMounted(() => {
    users += 1;
    now.value = Date.now();
    if (!timer) timer = setInterval(() => { now.value = Date.now(); }, 1000);
  });
  onUnmounted(() => {
    users -= 1;
    if (users === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
  return now;
}
