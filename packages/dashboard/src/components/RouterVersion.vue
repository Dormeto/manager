<script setup lang="ts">
// A router's version: an upgrade running (open it), an upgrade offered (administrators, routers the manager installed), or
// one available through its Terraform; its build below.
import { mdiArrowUpBold, mdiArrowUpBoldCircleOutline } from '@mdi/js';
import { terraformUpgradeHelp, upgradeHelp, upgradingHelp } from '../router-actions';
import { useSession } from '../stores/session';
import type { RouterInfo } from '../types';

defineProps<{ router: RouterInfo; available: string | null }>();
const emit = defineEmits<{ upgrade: [] }>();
const session = useSession();
</script>

<template>
  <div v-if="router.version" class="dm-version">
    <span class="dm-version__number">{{ router.version }}</span>
    <v-tooltip v-if="router.operation?.type === 'upgrade-router'" location="top" max-width="380" :text="upgradingHelp(router.name, available)">
      <template #activator="{ props }">
        <router-link v-bind="props" :to="{ path: '/operations', query: { id: router.operation.id } }" class="upgrading"
          :aria-label="`Upgrading ${router.name}: follow it in Operations`">
          <v-progress-circular indeterminate size="20" width="2" color="primary"><v-icon :icon="mdiArrowUpBold" size="11" color="primary" /></v-progress-circular>
          <span class="upgrading__text">upgrading</span>
        </router-link>
      </template>
    </v-tooltip>
    <template v-else-if="session.isAdmin && router.source === 'manager' && available && router.version !== available">
      <v-tooltip location="top" max-width="380" :text="upgradeHelp(router.name, router.version, available)">
        <template #activator="{ props }">
          <v-btn v-bind="props" :icon="mdiArrowUpBoldCircleOutline" variant="text" size="small" density="comfortable" color="secondary" class="dm-version__upgrade"
            :aria-label="`Upgrade ${router.name} to ${available}`" @click="emit('upgrade')" />
        </template>
      </v-tooltip>
      <span class="dm-version__next" aria-hidden="true">{{ available }}</span>
    </template>
    <template v-else-if="router.source === 'terraform' && available && router.version !== available">
      <v-tooltip location="top" max-width="380" :text="terraformUpgradeHelp(router.name, router.version, available)">
        <template #activator="{ props }">
          <v-icon v-bind="props" :icon="mdiArrowUpBoldCircleOutline" size="small" class="dm-version__hint" tabindex="0"
            :aria-label="`${router.name}: ${available} available, upgraded with Terraform`" />
        </template>
      </v-tooltip>
      <span class="dm-version__next dm-version__next--muted" aria-hidden="true">{{ available }}</span>
    </template>
  </div>
  <div v-if="router.version" class="dm-version__build mono">{{ router.build }}</div>
</template>

<style scoped>
.dm-version { display: flex; align-items: center; gap: 4px; min-height: 28px; white-space: nowrap; }
.dm-version__number { font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.dm-version__build { font-size: 0.72rem; letter-spacing: 0.02em; opacity: 0.55; }
/* An upgrade offered: the sun's color, a soft halo that breathes once in a while. */
.dm-version__upgrade { position: relative; margin-inline: -2px; }
.dm-version__upgrade::after { content: ""; position: absolute; inset: 6px; border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 0 0 rgba(var(--v-theme-secondary), 0.45); animation: dm-offer 3.6s var(--dm-ease) infinite; }
.dm-version__next { font: 500 0.72rem/1 var(--dm-mono); letter-spacing: 0.02em; color: rgb(var(--v-theme-secondary)); font-variant-numeric: tabular-nums; }
.dm-version__next--muted, .dm-version__hint { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-version__hint { border-radius: 50%; }
.dm-version__hint:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
/* An upgrade running: a small pill that opens its operation. */
.upgrading { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 3px; border-radius: 999px; text-decoration: none;
  color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), 0.1); border: 1px solid rgba(var(--v-theme-primary), 0.22);
  transition: background-color 0.2s; }
.upgrading:hover { background: rgba(var(--v-theme-primary), 0.18); }
.upgrading:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.upgrading__text { font: 500 0.7rem/1 var(--dm-mono); letter-spacing: 0.06em; text-transform: uppercase; }
@keyframes dm-offer { 0%, 55% { box-shadow: 0 0 0 0 rgba(var(--v-theme-secondary), 0.45); } 100% { box-shadow: 0 0 0 9px rgba(var(--v-theme-secondary), 0); } }
@media (prefers-reduced-motion: reduce) { .dm-version__upgrade::after { animation: none; } }
</style>
