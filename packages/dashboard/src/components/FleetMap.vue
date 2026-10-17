<script setup lang="ts">
// Every workload of the fleet as a small Dormeto icon in its state (asleep, waking or napping, awake, failed), grouped by
// router: the fleet at a glance, live. Past MAX, the others are dots. A click opens the workload.
import { computed, ref } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { stateColor } from '../format';
import DmLogo from './DmLogo.vue';
import type { WorkloadSummary } from '../types';

const MAX = 96;
const workloads = ref<WorkloadSummary[]>([]);
const loaded = ref(false);
usePoll(async () => {
  const answer = await api<{ workloads: WorkloadSummary[] }>('/workloads?limit=1000');
  workloads.value = answer.workloads;
  loaded.value = true;
});
const mood = (state: string): 'sleep' | 'load' | 'wake' => (state === 'ASLEEP' ? 'sleep' : state === 'NAPPING' || state === 'WAKING' ? 'load' : 'wake');
const routers = computed(() => {
  const by = new Map<string, WorkloadSummary[]>();
  for (const w of workloads.value) by.set(w.router, [...(by.get(w.router) ?? []), w]);
  let shown = 0;
  return [...by.entries()].map(([router, list]) => {
    const sorted = [...list].sort((a, b) => (a.name ?? a.workloadId).localeCompare(b.name ?? b.workloadId));
    const icons = sorted.slice(0, Math.max(0, MAX - shown));
    shown += icons.length;
    return { router, icons, dots: sorted.slice(icons.length) };
  });
});
</script>

<template>
  <div v-if="loaded && workloads.length" class="dm-map" role="list" aria-label="Every workload by router">
    <div v-for="r in routers" :key="r.router" class="dm-map__router" role="listitem">
      <div class="dm-map__label"><span class="dm-map__dot" />{{ r.router }}<span class="dm-map__n">{{ r.icons.length + r.dots.length }}</span></div>
      <div class="dm-map__icons">
        <v-tooltip v-for="(w, i) in r.icons" :key="w.workloadId" location="top" :text="`${w.name ?? w.workloadId} · ${w.state.toLowerCase()}`">
          <template #activator="{ props }">
            <router-link v-bind="props" :to="`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`" class="dm-map__icon"
              :class="{ 'is-failed': w.state === 'FAILED' }" :style="{ animationDelay: `${i * 35}ms` }" :aria-label="`${w.name ?? w.workloadId}, ${w.state.toLowerCase()}`">
              <DmLogo :state="mood(w.state)" :size="34" :zzz="w.state === 'ASLEEP'" />
            </router-link>
          </template>
        </v-tooltip>
        <router-link v-for="w in r.dots" :key="w.workloadId" :to="`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`"
          :class="`dm-map__more bg-${stateColor(w.state)}`" :aria-label="`${w.name ?? w.workloadId}, ${w.state.toLowerCase()}`" />
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
.dm-map__more { width: 10px; height: 10px; border-radius: 3px; }
@keyframes dm-pop { from { opacity: 0; transform: scale(0.4); } }
@keyframes dm-alarm { 50% { box-shadow: 0 0 0 2px rgb(var(--v-theme-error)), 0 0 16px 2px rgba(var(--v-theme-error), 0.6); } }
@media (max-width: 700px) { .dm-map__router { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
@media (prefers-reduced-motion: reduce) { .dm-map__icon, .dm-map__icon.is-failed::after { animation: none; } }
</style>
