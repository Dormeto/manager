<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useDisplay, useTheme } from 'vuetify';
import { useRoute } from 'vue-router';
import { mdiAccountCircle, mdiAccountGroup, mdiClipboardTextClock, mdiCompassOutline, mdiLogout, mdiRouterNetwork, mdiServerNetwork, mdiThemeLightDark, mdiViewDashboardOutline } from '@mdi/js';
import { signOut } from './auth';
import { getConfig } from './config';
import { useDiscoveryBadge } from './stores/discovery';
import { useSession } from './stores/session';

const session = useSession();
const badge = useDiscoveryBadge();
const theme = useTheme();
const route = useRoute();
const { mobile } = useDisplay();
const drawer = ref<boolean | null>(null);
const env = computed(() => getConfig().env);
const signedIn = computed(() => !route.meta.public);

const items = computed(() => [
  { title: 'Overview', to: '/', icon: mdiViewDashboardOutline },
  { title: 'Workloads', to: '/workloads', icon: mdiServerNetwork },
  { title: 'Routers', to: '/routers', icon: mdiRouterNetwork },
  { title: 'Discovery', to: '/discovery', icon: mdiCompassOutline, badge: badge.pending },
  ...(session.isAdmin ? [{ title: 'Users', to: '/users', icon: mdiAccountGroup }, { title: 'Audit', to: '/audit', icon: mdiClipboardTextClock }] : []),
]);

// Pending onboardings and offboardings of the last discovery run, next to Discovery.
onMounted(() => {
  if (signedIn.value) void badge.refresh();
});

function toggleTheme() {
  const next = theme.global.current.value.dark ? 'light' : 'dark';
  theme.change(next);
  try {
    window.localStorage.setItem('dmt-theme', next);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
</script>

<template>
  <v-app>
    <v-navigation-drawer v-if="signedIn" v-model="drawer" :temporary="mobile">
      <v-list nav density="comfortable">
        <v-list-item v-for="item in items" :key="item.to" :to="item.to" :prepend-icon="item.icon" :title="item.title" :exact="item.to === '/'">
          <template v-if="item.badge" #append>
            <v-badge :content="item.badge" color="primary" inline :aria-label="`${item.badge} pending onboardings or offboardings`" />
          </template>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>
    <v-app-bar flat border="b" density="comfortable">
      <v-app-bar-nav-icon v-if="signedIn" aria-label="Menu" @click="drawer = !drawer" />
      <v-app-bar-title>
        <span class="font-weight-bold">Dormeto</span>
        <v-chip class="ml-2" color="secondary" variant="tonal" label>{{ env }}</v-chip>
      </v-app-bar-title>
      <v-btn :icon="mdiThemeLightDark" aria-label="Toggle the theme" @click="toggleTheme" />
      <v-menu v-if="signedIn && session.email">
        <template #activator="{ props }">
          <v-btn v-bind="props" :icon="mdiAccountCircle" aria-label="Account" />
        </template>
        <v-list density="compact" min-width="240">
          <v-list-item :title="session.email" :subtitle="`Role: ${session.role}`" />
          <v-divider />
          <v-list-item :prepend-icon="mdiLogout" title="Sign out" @click="signOut(getConfig())" />
        </v-list>
      </v-menu>
    </v-app-bar>
    <v-main>
      <v-container fluid class="pa-4 pa-md-6" style="max-width: 1400px">
        <router-view />
      </v-container>
    </v-main>
  </v-app>
</template>
