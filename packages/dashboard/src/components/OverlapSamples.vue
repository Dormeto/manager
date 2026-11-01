<script setup lang="ts">
// The overlap rules of a workload's windows, drawn: each sample's bars on a time axis, allowed or refused. In a tooltip, whose
// surface is dark in both themes: the bars take the theme's colors as the card's chips do, awake filled and nap outlined as on
// the calendar, and every word takes the tooltip's own color.
import { mdiCheckCircle, mdiCloseCircle } from '@mdi/js';
import { OVERLAP_SAMPLES } from '../overlap-samples';

const described = (s: (typeof OVERLAP_SAMPLES)[number]) => `${s.allowed ? 'Allowed' : 'Refused'}: ${s.bars.map((b) => b.label).join(' and ')} on a time axis`;
</script>

<template>
  <div data-test="overlap-samples" class="dm-samples">
    <p class="dm-samples__lead">The rule is for the windows of <strong>one workload</strong>. With a recurrence the check looks 400 days ahead.</p>
    <div class="dm-samples__grid">
      <div v-for="s in OVERLAP_SAMPLES" :key="s.id" data-test="overlap-sample" :data-allowed="s.allowed" class="dm-sample">
        <div class="dm-sample__title">
          <v-icon :icon="s.allowed ? mdiCheckCircle : mdiCloseCircle" :color="s.allowed ? 'success' : 'error'" size="16" />
          <strong>{{ s.title }}</strong>
        </div>
        <div class="dm-sample__chart" role="img" :aria-label="described(s)">
          <div v-for="(b, i) in s.bars" :key="i" class="dm-sample__lane">
            <span class="dm-sample__label">{{ b.label }}</span>
            <span class="dm-sample__track"><span class="dm-bar" :class="`dm-bar--${b.kind}`" :style="{ left: `${b.from}%`, width: `${b.to - b.from}%` }" /></span>
          </div>
          <div class="dm-sample__lane">
            <span class="dm-sample__label" />
            <span class="dm-sample__axis"><span v-for="tick in s.axis" :key="tick">{{ tick }}</span></span>
          </div>
        </div>
        <div class="dm-sample__note">{{ s.note }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dm-samples { padding: 4px 2px; }
.dm-samples__lead { margin: 0 0 8px; }
.dm-samples__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 16px; }
.dm-sample__title { display: flex; align-items: center; gap: 4px; }
.dm-sample__chart { margin: 3px 0; }
.dm-sample__lane { display: flex; align-items: center; gap: 6px; height: 13px; }
.dm-sample__label { flex: 0 0 38px; font-size: 0.7rem; opacity: 0.85; }
.dm-sample__track { position: relative; flex: 1 1 auto; height: 9px; border-radius: 3px; background: rgba(255, 255, 255, 0.07); }
.dm-bar { position: absolute; top: 0; bottom: 0; border-radius: 3px; box-sizing: border-box; }
.dm-bar--awake { background: rgb(var(--v-theme-success)); }
/* Light on the dark surface whatever the theme: an outline in the info color would fade in the light theme's darker blue. */
.dm-bar--nap { border: 2px solid #8ab4f8; }
.dm-sample__axis { flex: 1 1 auto; display: flex; justify-content: space-between; font-size: 0.62rem; opacity: 0.7; }
.dm-sample__note { font-size: 0.74rem; line-height: 1.25; opacity: 0.9; }
</style>
