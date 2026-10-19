<script setup lang="ts">
// The navigation's own icons: drawn for Dormeto (a line in the text's color, one part in the sun's), each with a small
// motion when its item is pointed at or active (styled in style.css, .dm-nav-icon).
defineProps<{ name: 'overview' | 'workloads' | 'schedules' | 'routers' | 'discovery' | 'operations' | 'users' | 'audit' | 'update' }>();
</script>

<template>
  <svg class="dm-nav-icon" :class="`dm-nav-icon--${name}`" viewBox="0 0 24 24" width="23" height="23" aria-hidden="true" focusable="false">
    <template v-if="name === 'overview'">
      <rect class="ni-line" x="3" y="3" width="8" height="8" rx="2.2" />
      <rect class="ni-accent ni-tile" x="13" y="3" width="8" height="8" rx="2.2" />
      <rect class="ni-line" x="3" y="13" width="8" height="8" rx="2.2" />
      <rect class="ni-line" x="13" y="13" width="8" height="8" rx="2.2" />
    </template>
    <template v-else-if="name === 'workloads'">
      <rect class="ni-line" x="3" y="3.5" width="18" height="5" rx="1.8" />
      <rect class="ni-line" x="3" y="9.5" width="18" height="5" rx="1.8" />
      <rect class="ni-line" x="3" y="15.5" width="18" height="5" rx="1.8" />
      <circle class="ni-accent ni-led ni-led1" cx="17.5" cy="6" r="1.1" />
      <circle class="ni-accent ni-led ni-led2" cx="17.5" cy="12" r="1.1" />
      <circle class="ni-accent ni-led ni-led3" cx="17.5" cy="18" r="1.1" />
      <path class="ni-line" d="M6.5 6h5M6.5 12h5M6.5 18h5" />
    </template>
    <template v-else-if="name === 'schedules'">
      <rect class="ni-line" x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path class="ni-line" d="M3 9.5h18M8 2.8v3.4M16 2.8v3.4" />
      <rect class="ni-accent ni-tile" x="7" y="12.5" width="6" height="4.5" rx="1.2" />
    </template>
    <template v-else-if="name === 'routers'">
      <path class="ni-line ni-route" d="M6.2 12H9c1.8 0 2.8-.9 3.6-2.4l1-1.9c.7-1.3 1.6-2 3-2h.4M9 12c1.8 0 2.8.9 3.6 2.4l1 1.9c.7 1.3 1.6 2 3 2h.4" />
      <circle class="ni-line" cx="3.8" cy="12" r="2.4" />
      <circle class="ni-accent ni-node" cx="19.6" cy="5.7" r="2.6" />
      <circle class="ni-line" cx="19.6" cy="18.3" r="2.4" />
    </template>
    <template v-else-if="name === 'discovery'">
      <circle class="ni-line" cx="12" cy="12" r="8.5" />
      <g class="ni-needle">
        <path class="ni-accent" d="M12 5.5l2.2 6.5h-4.4z" />
        <path class="ni-line" d="M12 18.5l2.2-6.5h-4.4z" />
      </g>
    </template>
    <template v-else-if="name === 'operations'">
      <!-- Two cogs that mesh (8 and 6 teeth): each turns around its own center, the small one faster by the ratio. -->
      <g class="ni-cog ni-cog-big">
        <path class="ni-line" d="M12.27 9.64L13.79 8.97L15.03 10.21L14.36 11.73L14.90 13.02L16.44 13.62L16.44 15.38L14.90 15.98L14.36 17.27L15.03 18.79L13.79 20.03L12.27 19.36L10.98 19.90L10.38 21.44L8.62 21.44L8.02 19.90L6.73 19.36L5.21 20.03L3.97 18.79L4.64 17.27L4.10 15.98L2.56 15.38L2.56 13.62L4.10 13.02L4.64 11.73L3.97 10.21L5.21 8.97L6.73 9.64L8.02 9.10L8.62 7.56L10.38 7.56L10.98 9.10Z" />
        <circle class="ni-line" cx="9.5" cy="14.5" r="2" />
      </g>
      <path class="ni-accent ni-cog ni-cog-small" d="M20.64 8.26L21.27 9.56L20.12 10.71L18.82 10.08L17.63 10.40L16.82 11.60L15.24 11.18L15.14 9.74L14.26 8.86L12.82 8.76L12.40 7.18L13.60 6.37L13.92 5.18L13.29 3.88L14.44 2.73L15.74 3.36L16.93 3.04L17.74 1.84L19.32 2.26L19.42 3.70L20.30 4.58L21.74 4.68L22.16 6.26L20.96 7.07Z" />
    </template>
    <template v-else-if="name === 'users'">
      <circle class="ni-line" cx="9" cy="8.5" r="3.5" />
      <path class="ni-line" d="M2.8 20c.7-3.6 3.2-5.5 6.2-5.5s5.5 1.9 6.2 5.5" />
      <circle class="ni-accent ni-second" cx="17" cy="9.5" r="2.6" />
      <path class="ni-line ni-second" d="M16.5 14.6c2.4.2 4.2 1.9 4.7 4.9" />
    </template>
    <template v-else-if="name === 'update'">
      <circle class="ni-line" cx="12" cy="12" r="9" />
      <path class="ni-accent-line ni-arrow" d="M12 16.5v-9M8.2 11.2L12 7.4l3.8 3.8" />
    </template>
    <template v-else>
      <rect class="ni-line" x="5" y="3.5" width="14" height="17.5" rx="2.5" />
      <path class="ni-line" d="M9 3.5h6v2.5H9z" />
      <path class="ni-accent-line ni-check" d="M8.5 12.5l2 2 4-4.5" />
      <path class="ni-line" d="M8.5 17.5h7" />
    </template>
  </svg>
</template>
