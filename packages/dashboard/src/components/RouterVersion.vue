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
  <div v-if="router.version" class="d-flex align-center ga-1">
    <span>{{ router.version }}</span>
    <v-tooltip v-if="router.operation?.type === 'upgrade-router'" location="top" max-width="380" :text="upgradingHelp(router.name, available)">
      <template #activator="{ props }">
        <router-link v-bind="props" :to="{ path: '/operations', query: { id: router.operation.id } }" class="upgrading"
          :aria-label="`Upgrading ${router.name}: follow it in Operations`">
          <v-progress-circular indeterminate size="26" width="2" color="primary"><v-icon :icon="mdiArrowUpBold" size="14" color="primary" /></v-progress-circular>
        </router-link>
      </template>
    </v-tooltip>
    <v-tooltip v-else-if="session.isAdmin && router.source === 'manager' && available && router.version !== available" location="top" max-width="380"
      :text="upgradeHelp(router.name, router.version, available)">
      <template #activator="{ props }">
        <v-btn v-bind="props" :icon="mdiArrowUpBoldCircleOutline" variant="text" size="small" density="comfortable" color="primary"
          :aria-label="`Upgrade ${router.name} to ${available}`" @click="emit('upgrade')" />
      </template>
    </v-tooltip>
    <v-tooltip v-else-if="router.source === 'terraform' && available && router.version !== available" location="top" max-width="380"
      :text="terraformUpgradeHelp(router.name, router.version, available)">
      <template #activator="{ props }">
        <v-icon v-bind="props" :icon="mdiArrowUpBoldCircleOutline" size="small" class="text-medium-emphasis" tabindex="0"
          :aria-label="`${router.name}: ${available} available, upgraded with Terraform`" />
      </template>
    </v-tooltip>
  </div>
  <div v-if="router.version" class="text-body-small text-medium-emphasis mono">{{ router.build }}</div>
</template>

<style scoped>
.upgrading { display: inline-flex; text-decoration: none; }
</style>
