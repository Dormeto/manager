import { createRouter, createWebHistory } from 'vue-router';
import { api } from './api';
import { currentUser, signIn } from './auth';
import { useSession, type Me } from './stores/session';
import { usePreferences } from './stores/preferences';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: () => import('./views/OverviewView.vue') },
    { path: '/workloads', name: 'workloads', component: () => import('./views/WorkloadsView.vue') },
    { path: '/workloads/:router/:id', name: 'workload', component: () => import('./views/WorkloadView.vue'), props: true },
    { path: '/routers', name: 'routers', component: () => import('./views/RoutersView.vue') },
    { path: '/operations', name: 'operations', component: () => import('./views/OperationsView.vue') },
    { path: '/discovery', name: 'discovery', component: () => import('./views/DiscoveryView.vue') },
    { path: '/discovery/settings', name: 'discovery-settings', component: () => import('./views/DiscoverySettingsView.vue'), meta: { admin: true } },
    { path: '/users', name: 'users', component: () => import('./views/UsersView.vue'), meta: { admin: true } },
    { path: '/audit', name: 'audit', component: () => import('./views/AuditView.vue'), meta: { admin: true } },
    { path: '/account', name: 'account', component: () => import('./views/AccountView.vue') },
    { path: '/callback', name: 'callback', component: () => import('./views/CallbackView.vue'), meta: { public: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// Every view but the sign-in callback needs a session.
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const user = await currentUser();
  if (!user || user.expired) {
    await signIn(to.fullPath);
    return false;
  }
  const session = useSession();
  session.set(user);
  // The role the user acts with and their MFA (R6c), once per page load (the Account page reads them again).
  if (!session.loaded) {
    try {
      session.applyMe(await api<Me>('/me'));
    } catch {
      // Unreadable: the token's role, the API refuses what it must.
    }
  }
  void usePreferences().load();
  // Nothing is allowed until MFA is set up (policy required): the Account page only.
  if (session.loaded && session.effectiveRole === null && to.name !== 'account') return '/account';
  // The API enforces the roles; the dashboard only hides what the role cannot use.
  if (to.meta.admin && !session.isAdmin) return '/';
  return true;
});
