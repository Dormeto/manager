<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useDisplay, useTheme } from 'vuetify';
import { useRoute } from 'vue-router';
import { mdiAccountCogOutline, mdiLogout, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { api } from './api';
import { signOut } from './auth';
import { getConfig } from './config';
import { useDiscoveryBadge } from './stores/discovery';
import { useSession } from './stores/session';
import { useUpdateBadge } from './stores/update';
import MfaBanner from './components/MfaBanner.vue';
import DmLogo from './components/DmLogo.vue';
import NavIcon from './components/NavIcon.vue';

const session = useSession();
const badge = useDiscoveryBadge();
const updates = useUpdateBadge();
const theme = useTheme();
const route = useRoute();
const { mobile } = useDisplay();
const drawer = ref<boolean | null>(null);
const env = computed(() => getConfig().env);
const signedIn = computed(() => !route.meta.public);
const dark = computed(() => theme.global.current.value.dark);

type NavItem = { title: string; to: string; icon: InstanceType<typeof NavIcon>['$props']['name']; badge?: { count: number; label: string } };
// A badge, when its count is not 0, says what it counts to assistive technologies.
const item = (title: string, to: string, icon: NavItem['icon'], count?: number, label?: (n: number) => string): NavItem =>
  ({ title, to, icon, ...(count && label ? { badge: { count, label: label(count) } } : {}) });
const pendingLabel = (n: number) => `${n} pending onboardings or offboardings`;
const updatesLabel = (n: number) => (n === 1 ? '1 update available' : `${n} updates available`);
// The fleet, the organization, the people: the views in three groups.
// A member (R11) sees Overview and Workloads: the routers, discovery and operations are the built-in roles'.
const groups = computed<{ title: string; items: NavItem[] }[]>(() => [
  { title: 'Fleet', items: [item('Overview', '/', 'overview'), item('Workloads', '/workloads', 'workloads'), ...(session.isMember ? [] : [item('Routers', '/routers', 'routers')])] },
  ...(session.isMember ? [] : [{ title: 'Organization', items: [item('Discovery', '/discovery', 'discovery', badge.pending, pendingLabel), item('Operations', '/operations', 'operations')] }]),
  ...(session.isAdmin ? [{ title: 'Administration', items: [item('Users', '/users', 'users'), item('Audit', '/audit', 'audit'), item('Update', '/update', 'update', updates.count, updatesLabel)] }] : []),
]);
const initials = computed(() => (session.email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?');
// The role, and the one the user acts with when MFA lowers it (nothing at all under "required"): in the account menu and
// the drawer alike.
const roleText = computed(() => `Role: ${session.role}${session.loaded && session.effectiveRole !== session.role ? ` (acting as ${session.effectiveRole ?? 'nothing'})` : ''}`);

// Pending onboardings and offboardings of the last discovery run, next to Discovery.
watch(() => signedIn.value && !session.isMember, (yes) => {
  if (yes) void badge.refresh();
}, { immediate: true });

// The manager's own version (the release's, from the public /health), read once when signed in; nothing while unknown.
const version = ref('');
watch(signedIn, (yes) => {
  if (!yes || version.value) return;
  api<{ version?: string }>('/health').then((h) => { version.value = h.version ?? ''; }, () => { version.value = ''; });
}, { immediate: true });

// The versions to update to, next to Update: read when the user is known as an administrator, then every 30 minutes (the
// Update page also gives each state it loads).
const UPDATES_MS = 30 * 60_000;
let updatesTimer: ReturnType<typeof setInterval> | undefined;
watch(() => signedIn.value && session.isAdmin, (admin) => {
  clearInterval(updatesTimer);
  updatesTimer = undefined;
  if (!admin) return;
  void updates.refresh();
  updatesTimer = setInterval(() => void updates.refresh(), UPDATES_MS);
}, { immediate: true });
onBeforeUnmount(() => clearInterval(updatesTimer));

function toggleTheme() {
  const next = dark.value ? 'light' : 'dark';
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
    <v-navigation-drawer v-if="signedIn" v-model="drawer" :temporary="mobile" width="264" class="dm-drawer">
      <router-link to="/" class="dm-brand dm-wakes" aria-label="Dormeto overview">
        <DmLogo still :size="34" :zzz="false" />
        <span class="dm-brand__name">Dormeto</span>
      </router-link>
      <v-list nav density="comfortable" class="px-3">
        <template v-for="group in groups" :key="group.title">
          <v-list-subheader class="dm-nav-group">{{ group.title }}</v-list-subheader>
          <v-list-item v-for="entry in group.items" :key="entry.to" :to="entry.to" :title="entry.title" :exact="entry.to === '/'" class="dm-nav-item">
            <template #prepend><span class="dm-nav-well"><NavIcon :name="entry.icon" /></span></template>
            <template v-if="entry.badge" #append>
              <v-badge :content="entry.badge.count" color="secondary" inline :aria-label="entry.badge.label" />
            </template>
          </v-list-item>
        </template>
      </v-list>
      <template #append>
        <div v-if="session.email" class="dm-me">
          <v-avatar size="34" class="dm-me__avatar">{{ initials }}</v-avatar>
          <div class="dm-me__who">
            <div class="dm-me__email">{{ session.email }}</div>
            <div class="dm-me__role">{{ roleText }}</div>
          </div>
        </div>
        <div v-if="version" class="dm-version">Dormeto manager {{ version }}</div>
      </template>
    </v-navigation-drawer>
    <v-app-bar flat border="b" density="comfortable" class="dm-bar">
      <v-app-bar-nav-icon v-if="signedIn" aria-label="Menu" @click="drawer = !drawer" />
      <v-app-bar-title>
        <span class="d-inline-flex align-center ga-2">
          <span v-if="!signedIn || mobile" class="d-inline-flex align-center ga-2 font-weight-bold"><DmLogo still :size="26" :zzz="false" />Dormeto</span>
          <!-- The environment, in the bar whatever the drawer: dev or prod at a glance. -->
          <v-chip color="secondary" variant="tonal" label class="dm-env">{{ env }}</v-chip>
        </span>
      </v-app-bar-title>
      <v-btn :icon="dark ? mdiWeatherSunny : mdiWeatherNight" :aria-label="dark ? 'Switch to the light theme' : 'Switch to the night theme'" @click="toggleTheme" />
      <v-menu v-if="signedIn && session.email">
        <template #activator="{ props }">
          <v-btn v-bind="props" icon aria-label="Account"><v-avatar size="30" class="dm-me__avatar">{{ initials }}</v-avatar></v-btn>
        </template>
        <v-list density="compact" min-width="260">
          <v-list-item :title="session.email" :subtitle="roleText" />
          <v-divider />
          <v-list-item :prepend-icon="mdiAccountCogOutline" title="Account and two-step verification" to="/account" />
          <v-list-item :prepend-icon="mdiLogout" title="Sign out" @click="signOut(getConfig())" />
        </v-list>
      </v-menu>
    </v-app-bar>
    <v-main>
      <v-container fluid class="pa-4 pa-md-8">
        <MfaBanner v-if="signedIn" />
        <router-view v-slot="{ Component, route: current }">
          <div :key="current.path" class="dm-page"><component :is="Component" /></div>
        </router-view>
      </v-container>
    </v-main>
  </v-app>
</template>

<style scoped>
.dm-brand { display: flex; align-items: center; gap: 11px; padding: 20px 22px 14px; color: inherit; text-decoration: none; }
.dm-brand__name { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.03em; }
.dm-env { font-family: var(--dm-mono); }
.dm-nav-group { font: 500 0.64rem/1 var(--dm-mono) !important; letter-spacing: 0.12em; text-transform: uppercase; min-height: 32px !important; padding-inline-start: 12px !important; margin-top: 10px; }
.dm-me { display: flex; align-items: center; gap: 10px; margin: 12px; padding: 10px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; }
.dm-me__avatar { background: linear-gradient(155deg, #4589ca, #034b80); color: #fff; font-size: 0.72rem; font-weight: 600; }
.dm-me__who { min-width: 0; }
.dm-me__email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82rem; font-weight: 500; }
.dm-version { margin: -4px 12px 12px; padding: 0 12px; font: 500 0.62rem/1.4 var(--dm-mono); letter-spacing: 0.08em; opacity: 0.5; }
.dm-me__role { font: 500 0.62rem/1.4 var(--dm-mono); letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
</style>
