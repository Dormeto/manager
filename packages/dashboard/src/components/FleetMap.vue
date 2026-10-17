<script setup lang="ts">
// The fleet's workloads as small Dormeto icons in their state (asleep, waking or napping, awake, failed), grouped by router:
// the fleet at a glance, live. The first MAX workloads only are asked for (one request, never every workload) and shown as
// icons, a click opening the workload; each router's count comes from the routers the Overview has, the others are dots of
// their state (a picture, out of the tab order) and a "+N more" link to the router's workloads.
import { computed, ref } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { stateColor } from '../format';
import DmLogo from './DmLogo.vue';
import type { RouterInfo, WorkloadSummary } from '../types';

const MAX = 96;
// At most this many dots in all (a fleet of thousands): "+N more" says them all.
const DOTS_MAX = 900;
const DOT_ORDER = ['AWAKE', 'WAKING', 'NAPPING', 'ASLEEP', 'FAILED'];
const props = defineProps<{ routers: RouterInfo[] }>();
const workloads = ref<WorkloadSummary[]>([]);
const loaded = ref(false);
usePoll(async () => {
  const answer = await api<{ workloads: WorkloadSummary[] }>(`/workloads?limit=${MAX}`);
  workloads.value = answer.workloads;
  loaded.value = true;
});
const mood = (state: string): 'sleep' | 'load' | 'wake' => (state === 'ASLEEP' ? 'sleep' : state === 'NAPPING' || state === 'WAKING' ? 'load' : 'wake');
const rank = (state: string) => (DOT_ORDER.includes(state) ? DOT_ORDER.indexOf(state) : DOT_ORDER.length);
const routers = computed(() => {
  const by = new Map<string, WorkloadSummary[]>();
  for (const w of workloads.value) by.set(w.router, [...(by.get(w.router) ?? []), w]);
  const names = [...props.routers.map((r) => r.name), ...[...by.keys()].filter((name) => !props.routers.some((r) => r.name === name))];
  let dotsLeft = DOTS_MAX;
  return names.map((router) => {
    const info = props.routers.find((r) => r.name === router);
    const icons = [...(by.get(router) ?? [])].sort((a, b) => (a.name ?? a.workloadId).localeCompare(b.name ?? b.workloadId));
    const count = Math.max(info?.workloads ?? 0, icons.length);
    // The others by state: the router's counts less its icons.
    const rest: Record<string, number> = { ...(info?.workloadStates ?? {}) };
    for (const w of icons) rest[w.state] = Math.max(0, (rest[w.state] ?? 0) - 1);
    const dots = Object.entries(rest).sort(([a], [b]) => rank(a) - rank(b)).flatMap(([state, n]) => Array.from({ length: n }, () => state));
    const shown = dots.slice(0, Math.max(0, dotsLeft));
    dotsLeft -= shown.length;
    return { router, icons, count, more: count - icons.length, dots: shown };
  }).filter((r) => r.count > 0);
});
</script>

<template>
  <div v-if="loaded && routers.length" class="dm-map" role="list" aria-label="The workloads by router">
    <div v-for="r in routers" :key="r.router" class="dm-map__router" role="listitem">
      <div class="dm-map__label"><span class="dm-map__dot" />{{ r.router }}<span class="dm-map__n">{{ r.count }}</span></div>
      <div class="dm-map__icons">
        <v-tooltip v-for="(w, i) in r.icons" :key="w.workloadId" location="top" :text="`${w.name ?? w.workloadId} · ${w.state.toLowerCase()}`">
          <template #activator="{ props: tip }">
            <router-link v-bind="tip" :to="`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`" class="dm-map__icon"
              :class="{ 'is-failed': w.state === 'FAILED' }" :style="{ animationDelay: `${i * 35}ms` }" :aria-label="`${w.name ?? w.workloadId}, ${w.state.toLowerCase()}`">
              <DmLogo :state="mood(w.state)" :size="34" :zzz="w.state === 'ASLEEP'" />
            </router-link>
          </template>
        </v-tooltip>
        <span v-if="r.dots.length" class="dm-map__dots" aria-hidden="true"><span v-for="(state, i) in r.dots" :key="i" :class="`dm-map__more bg-${stateColor(state)}`" /></span>
        <router-link v-if="r.more > 0" :to="{ path: '/workloads', query: { router: r.router } }" class="dm-map__all" :aria-label="`${r.more} more workloads of ${r.router}`">+{{ r.more }} more</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dm-map { display: grid; gap: 14px; }
.dm-map__router { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 16px; align-items: center; }
.dm-map__label { display: flex; align-items: center; gap: 8px; min-width: 0; font: 500 0.72rem/1.3 var(--dm-mono); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-map__dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgb(var(--v-theme-primary)); box-shadow: 0 0 10px rgb(var(--v-theme-primary)); }
.dm-map__n { margin-left: auto; padding: 1px 7px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.07); }
.dm-map__icons { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dm-map__icon { position: relative; display: block; border-radius: 10px; animation: dm-pop 0.55s var(--dm-spring) backwards; transition: transform 0.3s var(--dm-spring), filter 0.3s; }
.dm-map__icon:hover, .dm-map__icon:focus-visible { transform: translateY(-3px) scale(1.12); filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.45)); z-index: 1; }
.dm-map__icon.is-failed::after { content: ""; position: absolute; inset: -3px; border-radius: 12px; box-shadow: 0 0 0 2px rgb(var(--v-theme-error)); animation: dm-alarm 1.6s ease-in-out infinite; }
.dm-map__dots { display: contents; }
.dm-map__more { width: 10px; height: 10px; border-radius: 3px; }
.dm-map__all { font: 500 0.72rem/1.3 var(--dm-mono); color: rgb(var(--v-theme-primary)); text-decoration: none; white-space: nowrap; border-radius: 4px; }
.dm-map__all:hover { text-decoration: underline; }
.dm-map__all:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
/* The icons at rest are still (so many in motion would be a lot): each one moves when pointed at or focused. */
.dm-map__icon:not(:hover):not(:focus-visible) :deep(.dm *) { animation: none; }
@keyframes dm-pop { from { opacity: 0; transform: scale(0.4); } }
@keyframes dm-alarm { 50% { box-shadow: 0 0 0 2px rgb(var(--v-theme-error)), 0 0 16px 2px rgba(var(--v-theme-error), 0.6); } }
@media (max-width: 700px) { .dm-map__router { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
@media (prefers-reduced-motion: reduce) {
  .dm-map__icon, .dm-map__icon.is-failed::after { animation: none; }
  .dm-map__icon { transition: none; }
  .dm-map__icon:hover, .dm-map__icon:focus-visible { transform: none; }
}
</style>
