<script setup lang="ts">
// The Schedule and New window dialogs' help, in tooltips reached by hover, keyboard and touch (a tap is a hover: on open-on-click too
// it would open and close at once): what a schedule overrides and what
// wins over it (the router's controller and waker), and the overlap rules, drawn.
import { mdiInformationOutline } from '@mdi/js';
import OverlapSamples from './OverlapSamples.vue';

defineProps<{ overlaps?: boolean }>();
</script>

<template>
  <span class="dm-help">
    <v-tooltip location="bottom" max-width="min(92vw, 480px)" open-on-focus>
      <template #activator="{ props: activator }">
        <v-btn v-bind="activator" data-test="schedule-help" :icon="mdiInformationOutline" variant="text" size="x-small" aria-label="How a schedule behaves" />
      </template>
      <div data-test="schedule-help-text" class="dm-help__text">
        <p>A schedule overrides the idle behaviour, in its time zone.</p>
        <ul>
          <li><strong>In an awake window</strong> idle naps do not happen, and it wakes when the window starts.</li>
          <li><strong>In a nap window</strong> it naps when the window starts, and requests do not wake it, or only with the x-dormeto-wake header if the window allows it.</li>
          <li><strong>Outside windows</strong> the idle rules apply as usual.</li>
        </ul>
        <p>What wins over a schedule:</p>
        <ul>
          <li><strong>A pause.</strong> While paused nothing naps it: no nap window, no idle nap, and a manager's Nap is refused. A pause that keeps it asleep also holds the awake windows' wakes. A window held applies when the pause ends, if it is still running.</li>
          <li><strong>A manager's Wake</strong> wakes it at once, even in a nap window. That window does not nap it again; an idle nap can, and so does the next nap window's start.</li>
          <li><strong>A manager's Nap</strong> naps it at once, even in an awake window. That window does not wake it again; a request can, and so does the next awake window's start.</li>
        </ul>
      </div>
    </v-tooltip>
    <v-tooltip location="bottom" max-width="min(94vw, 580px)" open-on-focus>
      <template #activator="{ props: activator }">
        <v-btn v-bind="activator" data-test="overlap-help" variant="text" size="x-small" class="dm-help__overlaps" :prepend-icon="mdiInformationOutline">Overlaps</v-btn>
      </template>
      <OverlapSamples />
    </v-tooltip>
  </span>
</template>

<style scoped>
.dm-help { display: inline-flex; align-items: center; gap: 2px; vertical-align: middle; }
.dm-help__overlaps { text-transform: none; letter-spacing: normal; }
.dm-help__text p { margin: 2px 0; }
.dm-help__text ul { margin: 2px 0 6px; padding-left: 16px; }
.dm-help__text li { margin-bottom: 2px; }
</style>
