// Big numbers count up when they arrive or change, as the overview's do: an ease-out of about a second, ending on the exact
// value (a whole number counts in whole numbers). At once where motion is reduced, or without a browser's animation frames.
import { getCurrentScope, onScopeDispose, ref, watch, type Ref, type WatchSource } from 'vue';

export function useCountUp(source: WatchSource<number | null | undefined>, duration = 900): Readonly<Ref<number>> {
  const shown = ref(0);
  const still = typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function' || typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame = 0;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  watch(source, (value) => {
    const to = value ?? 0;
    const from = shown.value;
    stop();
    if (still || from === to || !Number.isFinite(to) || !Number.isFinite(from)) {
      shown.value = to;
      return;
    }
    const whole = Number.isInteger(to);
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - start) / duration));
      const v = from + (to - from) * (1 - (1 - p) ** 3);
      shown.value = p < 1 ? (whole ? Math.round(v) : v) : to;
      frame = p < 1 ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
  }, { immediate: true });
  if (getCurrentScope()) onScopeDispose(stop);
  return shown;
}
