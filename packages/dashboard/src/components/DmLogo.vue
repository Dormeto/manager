<script setup lang="ts">
// The Dormeto icon, the website's: asleep (the moon, stars and "z"), loading (the sun's rays turn), awake (the sun rises,
// the eyes open, then blink). still: the brand's icon at rest, which wakes when a .dm-wakes parent is pointed at.
import { computed, useId } from 'vue';

const props = withDefaults(defineProps<{ state?: 'sleep' | 'load' | 'wake'; size?: number; still?: boolean; zzz?: boolean }>(), {
  state: 'wake', size: 32, still: false, zzz: true,
});
const clip = `dm-clip-${useId()}`;
const classes = computed(() => ['dm', props.still ? 'dm--still' : `is-${props.state}`, props.size < 40 ? 'dm--small' : '']);
const STARS: [number, number, number, number][] = [[7, 7, 0.8, 0], [19, 5, 0.55, 0.7], [37, 5.5, 0.6, 1.3], [59, 31, 0.7, 0.4], [57, 54, 0.9, 1.9], [7, 57, 0.6, 1.1], [21, 58, 0.5, 2.3]];
const RAYS: [number, string][] = [[0, 'M52 4.5L52 2.5'], [1, 'M57.3 6.7L58.72 5.28'], [2, 'M59.5 12L61.5 12'], [3, 'M57.3 17.3L58.72 18.72'],
  [4, 'M52 19.5L52 21.5'], [6, 'M44.5 12L42.5 12'], [7, 'M46.7 6.7L45.28 5.28']];
const Z = 'M0 0h4.4L0 4.6h4.4';
</script>

<template>
  <svg :class="classes" :width="size" :height="size" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs><clipPath :id="clip"><rect width="64" height="64" rx="14" /></clipPath></defs>
    <g :clip-path="`url(#${clip})`">
      <rect class="dm-tile" width="64" height="64" />
      <g class="dm-stars"><circle v-for="([x, y, r, d], i) in STARS" :key="i" :cx="x" :cy="y" :r="r" :style="{ '--d': `${d}s` }" /></g>
      <g class="dm-sun-x"><g class="dm-sun-y">
        <g class="dm-rays"><path v-for="[i, d] in RAYS" :key="i" class="dm-ray" :style="{ '--i': i }" :d="d" /></g>
        <circle class="dm-sun-core" cx="52" cy="12" r="5" />
      </g></g>
      <g transform="translate(-3 0)">
        <g transform="rotate(5 30 32)"><path class="dm-moon" d="M30 12A20.69 20.69 0 1 1 30 52A20 20 0 0 0 30 12Z" /></g>
        <g class="dm-face">
          <path class="dm-head" d="M14 16Q14 12 18 12H30A20 20 0 0 1 30 52H14Z" />
          <path class="dm-eye-closed" d="M21 32q4 3.6 8 0M35 32q4 3.6 8 0" />
          <g class="dm-eyes">
            <ellipse class="dm-eye-open" cx="25" cy="32.4" rx="2.7" ry="3.2" />
            <ellipse class="dm-eye-open" cx="39" cy="32.4" rx="2.7" ry="3.2" />
            <circle class="dm-eye-open dm-glint" cx="26" cy="31.2" r="0.9" />
            <circle class="dm-eye-open dm-glint" cx="40" cy="31.2" r="0.9" />
          </g>
        </g>
      </g>
    </g>
    <g v-if="zzz" class="dm-zzz">
      <g transform="translate(52 9)"><path class="dm-z" :d="Z" style="--d: 0s" /></g>
      <g transform="translate(53 7.5) scale(1.25)"><path class="dm-z" :d="Z" style="--d: 1s" /></g>
      <g transform="translate(51 10) scale(.9)"><path class="dm-z" :d="Z" style="--d: 2s" /></g>
    </g>
  </svg>
</template>
