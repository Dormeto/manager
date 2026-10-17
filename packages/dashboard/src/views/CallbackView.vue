<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeSignIn } from '../auth';
import DmLogo from '../components/DmLogo.vue';

const router = useRouter();
const error = ref('');
// The icon turns its sun's rays while the sign-in completes, and wakes while the dashboard opens.
const signedIn = ref(false);

onMounted(async () => {
  try {
    const to = await completeSignIn();
    signedIn.value = true;
    await router.replace(to);
  } catch (err) {
    error.value = (err as Error).message;
  }
});
</script>

<template>
  <div class="dm-callback">
    <div class="dm-callback__sky" aria-hidden="true"><span class="dm-callback__stars" /><span class="dm-callback__stars dm-callback__stars--late" /></div>
    <div class="dm-callback__body">
      <div class="dm-callback__icon">
        <div class="dm-callback__glow" aria-hidden="true" />
        <DmLogo :state="error ? 'sleep' : signedIn ? 'wake' : 'load'" :size="120" />
      </div>
      <v-alert v-if="error" type="error" variant="tonal" title="Sign-in failed" :text="error" class="dm-callback__alert">
        <template #append><v-btn variant="text" href="/">Try again</v-btn></template>
      </v-alert>
      <p v-else class="dm-callback__text" role="status" aria-live="polite">Signing you in…</p>
    </div>
  </div>
</template>

<style scoped>
/* The whole window under the bar, the container's padding undone: the night sky. */
.dm-callback { position: relative; display: grid; place-items: center; min-height: calc(100dvh - var(--v-layout-top, 56px)); margin: -16px; padding: 32px 16px;
  overflow: hidden; --eye-delay: 0.1s; --ray-delay: 0s; }
@media (min-width: 960px) { .dm-callback { margin: -32px; } }
.dm-callback__sky { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(60% 50% at 50% 42%, rgba(var(--v-theme-primary), 0.12), transparent 70%),
    radial-gradient(120% 70% at 50% 0%, rgba(var(--v-theme-night), 0.95), transparent 72%),
    linear-gradient(180deg, rgba(var(--v-theme-night), 0.5), transparent 85%); }
.dm-callback__stars { position: absolute; inset: 0; opacity: 0.8; animation: dm-twinkle-sky 4.8s ease-in-out infinite;
  background-image: radial-gradient(1.2px 1.2px at 8% 14%, rgba(var(--v-theme-on-surface), 0.9), transparent), radial-gradient(1px 1px at 22% 32%, rgba(var(--v-theme-on-surface), 0.7), transparent),
    radial-gradient(1.4px 1.4px at 36% 9%, rgba(var(--v-theme-on-surface), 0.85), transparent), radial-gradient(1px 1px at 61% 21%, rgba(var(--v-theme-on-surface), 0.7), transparent),
    radial-gradient(1.3px 1.3px at 79% 11%, rgba(var(--v-theme-on-surface), 0.9), transparent), radial-gradient(1px 1px at 91% 36%, rgba(var(--v-theme-on-surface), 0.6), transparent),
    radial-gradient(1px 1px at 14% 58%, rgba(var(--v-theme-on-surface), 0.55), transparent), radial-gradient(1.2px 1.2px at 86% 64%, rgba(var(--v-theme-on-surface), 0.6), transparent); }
.dm-callback__stars--late { animation-delay: -2.4s; opacity: 0.6;
  background-image: radial-gradient(1px 1px at 4% 38%, rgba(var(--v-theme-moon), 0.9), transparent), radial-gradient(1.2px 1.2px at 29% 18%, rgba(var(--v-theme-on-surface), 0.7), transparent),
    radial-gradient(1px 1px at 47% 27%, rgba(var(--v-theme-on-surface), 0.6), transparent), radial-gradient(1.4px 1.4px at 68% 6%, rgba(var(--v-theme-moon), 0.9), transparent),
    radial-gradient(1px 1px at 72% 40%, rgba(var(--v-theme-on-surface), 0.6), transparent), radial-gradient(1.2px 1.2px at 95% 18%, rgba(var(--v-theme-on-surface), 0.8), transparent),
    radial-gradient(1px 1px at 52% 70%, rgba(var(--v-theme-on-surface), 0.45), transparent); }
/* The day: a pale sky, no stars. */
.v-theme--light .dm-callback__sky {
  background: radial-gradient(60% 50% at 50% 42%, rgba(var(--v-theme-primary), 0.1), transparent 70%), radial-gradient(120% 70% at 50% 0%, rgba(var(--v-theme-primary), 0.12), transparent 72%); }
.v-theme--light .dm-callback__stars { display: none; }

.dm-callback__body { position: relative; display: grid; justify-items: center; gap: 28px; width: min(100%, 520px); text-align: center; }
.dm-callback__icon { position: relative; display: grid; place-items: center; width: 184px; height: 184px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.16); }
.dm-callback__glow { position: absolute; inset: 10px; border-radius: 50%; filter: blur(40px); opacity: 0.55; animation: dm-callback-glow 2.4s ease-in-out infinite;
  background: radial-gradient(closest-side, rgba(var(--v-theme-primary), 0.6), rgba(var(--v-theme-sun), 0.25) 60%, transparent); }
.dm-callback__icon :deep(.dm) { position: relative; }
.dm-callback__text { margin: 0; font-size: clamp(1.3rem, 1.1rem + 0.8vw, 1.6rem); font-weight: 600; letter-spacing: -0.035em; }
.dm-callback__alert { width: 100%; text-align: start; border: 1px solid rgba(var(--v-theme-error), 0.3); backdrop-filter: blur(12px); }
.dm-callback__alert :deep(.v-alert__content) { color: rgba(var(--v-theme-on-surface), 0.9); overflow-wrap: anywhere; }
.dm-callback__alert :deep(.v-alert-title) { color: rgb(var(--v-theme-error)); }
@keyframes dm-callback-glow { 50% { opacity: 0.85; transform: scale(1.08); } }
@keyframes dm-twinkle-sky { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) {
  .dm-callback__glow, .dm-callback__stars { animation: none; }
}
</style>
