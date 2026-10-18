<script setup lang="ts">
// The navigation's own icons: drawn for Dormeto (a line in the text's color, one part in the sun's), each with a small
// motion when its item is pointed at or active (styled in style.css, .dm-nav-icon).
defineProps<{ name: 'overview' | 'workloads' | 'routers' | 'discovery' | 'operations' | 'users' | 'audit' | 'update' }>();
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
      <g class="ni-gear">
        <path class="ni-line" d="M12 2.8l1.6 2.4 2.8-.8.5 2.9 2.7 1.1-1.2 2.6 1.2 2.6-2.7 1.1-.5 2.9-2.8-.8L12 21.2l-1.6-2.4-2.8.8-.5-2.9-2.7-1.1L5.6 13 4.4 10.4l2.7-1.1.5-2.9 2.8.8z" />
      </g>
      <circle class="ni-accent" cx="12" cy="12" r="2.8" />
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
