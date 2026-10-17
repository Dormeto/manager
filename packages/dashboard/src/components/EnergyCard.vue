<script setup lang="ts">
// The energy the fleet's naps saved over the last 30 days, and its carbon, as the API estimates it with the bar of all
// workloads (GET /workloads/states, the Overview's): each workload's last nap's items times its hours asleep within the
// savings baseline, in its own region; then an everyday equivalent, one after the other. Without a workload estimated, no
// estimate yet (never a zero).
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { mdiCar, mdiCellphone, mdiCoffeeOutline, mdiLeaf, mdiTelevisionPlay } from '@mdi/js';
import { equivalents, rounded, type FleetEnergy } from '../energy';
import DmLoader from './DmLoader.vue';

// energy: none without prices; loaded: the Overview has its answer; error: it could not read it.
const props = defineProps<{ energy?: FleetEnergy | null; loaded: boolean; error?: string }>();
const energy = computed(() => (props.energy?.workloads ? props.energy : null));
const workloads = computed(() => energy.value?.workloads ?? 0);
const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The numbers count up when they arrive.
const shown = ref({ kwh: 0, co2Kg: 0 });
watch(energy, (e) => {
  if (!e) return;
  if (reduced) { shown.value = { kwh: e.kwh, co2Kg: e.co2Kg }; return; }
  const from = { ...shown.value };
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / 1200);
    const k = 1 - (1 - p) ** 3;
    shown.value = { kwh: from.kwh + (e.kwh - from.kwh) * k, co2Kg: from.co2Kg + (e.co2Kg - from.co2Kg) * k };
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, { immediate: true });

const ICONS = { phone: mdiCellphone, stream: mdiTelevisionPlay, tea: mdiCoffeeOutline, car: mdiCar };
const items = computed(() => (energy.value ? equivalents(energy.value).map((e) => ({ ...e, icon: ICONS[e.icon] })) : []));
const index = ref(0);
const timer = reduced ? null : setInterval(() => { index.value = (index.value + 1) % Math.max(1, items.value.length); }, 4200);
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <v-card class="dm-energy">
    <div class="dm-energy__glow" aria-hidden="true" />
    <v-card-text>
      <div class="d-flex align-center ga-2 mb-3">
        <v-icon :icon="mdiLeaf" color="success" size="20" />
        <span class="dm-eyebrow">Energy not used · last 30 days</span>
      </div>
      <v-alert v-if="error" type="warning" variant="tonal" density="compact" :text="error" />
      <template v-else-if="energy">
        <div class="d-flex flex-wrap align-end ga-6">
          <div>
            <div class="dm-energy__value">{{ rounded(shown.kwh) }}<span> kWh</span></div>
            <div class="text-body-small text-medium-emphasis">the naps' stopped compute</div>
          </div>
          <div>
            <div class="dm-energy__value dm-energy__value--co2">{{ rounded(shown.co2Kg) }}<span> kg CO₂e</span></div>
            <div class="text-body-small text-medium-emphasis">at each region's grid intensity</div>
          </div>
        </div>
        <div class="dm-energy__equivs">
          <div v-for="(e, i) in items" :key="e.text" class="dm-energy__equiv" :class="{ 'is-lit': i === index }">
            <v-icon :icon="e.icon" size="20" />
            <div><b>≈ {{ rounded(e.value) }}</b><span>{{ e.text }}</span></div>
          </div>
        </div>
        <div class="text-body-small text-medium-emphasis">Estimate from {{ workloads }} workload{{ workloads === 1 ? '' : 's' }}: each one's last nap's items
          applied to every hour asleep within the savings baseline over the last 30 days (business hours or every hour, as the manager is
          set), at 50% CPU use, in its region (an unknown region at the average); items of unknown size and pods without a node autoscaler left
          out. Cloud Carbon Footprint's coefficients for AWS. Not a measure.</div>
      </template>
      <div v-else-if="loaded" class="text-body-medium text-medium-emphasis">No estimate yet: it comes with the naps' figures, from what each nap
        stopped (its instances, databases, tasks or pods of a known size) and its hours asleep.</div>
      <DmLoader v-else label="Weighing the naps…" :size="48" />
    </v-card-text>
  </v-card>
</template>

<style scoped>
.dm-energy { position: relative; overflow: hidden; }
.dm-energy__glow { position: absolute; right: -80px; bottom: -80px; width: 260px; height: 260px; border-radius: 50%; filter: blur(60px); opacity: 0.35; pointer-events: none;
  background: radial-gradient(closest-side, rgb(var(--v-theme-success)), transparent); }
.dm-energy__value { font-size: clamp(2rem, 1.6rem + 1.2vw, 2.6rem); font-weight: 600; line-height: 1; letter-spacing: -0.045em; font-variant-numeric: tabular-nums; }
.dm-energy__value span { font-size: 1rem; font-weight: 500; letter-spacing: 0; opacity: 0.7; }
.dm-energy__value--co2 { color: rgb(var(--v-theme-success)); }
.dm-energy__equivs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 20px 0 14px; }
.dm-energy__equiv { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.02); transition: border-color 0.5s, background-color 0.5s, transform 0.5s var(--dm-ease); }
.dm-energy__equiv .v-icon { opacity: 0.6; transition: opacity 0.5s, color 0.5s; }
.dm-energy__equiv b { display: block; font-size: 1.2rem; font-weight: 600; letter-spacing: -0.03em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.dm-energy__equiv span { display: block; font-size: 0.78rem; line-height: 1.3; opacity: 0.7; }
.dm-energy__equiv.is-lit { border-color: rgba(var(--v-theme-success), 0.45); background: rgba(var(--v-theme-success), 0.09); transform: translateY(-2px); }
.dm-energy__equiv.is-lit .v-icon { opacity: 1; color: rgb(var(--v-theme-success)); }
@media (max-width: 520px) { .dm-energy__equivs { grid-template-columns: minmax(0, 1fr); } }
</style>
