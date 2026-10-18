<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { computed, ref } from 'vue';
import {
  mdiAccountCancelOutline, mdiAccountCheckOutline, mdiAccountEyeOutline, mdiAccountGroupOutline, mdiAccountPlus, mdiAccountWrenchOutline, mdiCancel, mdiCheckCircleOutline,
  mdiDotsVertical, mdiEmailFastOutline, mdiEmailSyncOutline, mdiLockReset, mdiShieldAccountOutline, mdiShieldAlertOutline, mdiShieldCheckOutline,
  mdiShieldOffOutline, mdiShieldRefreshOutline,
} from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useSession } from '../stores/session';
import DmLoader from '../components/DmLoader.vue';
import NoticeAlert from '../components/NoticeAlert.vue';
import { useCountUp } from '../count-up';

// mfa: null when Cognito could not say.
interface User { email: string; role: string; status: string; enabled: boolean; createdAt: string | null; mfa?: boolean | null }

const now = useNow();
const { smAndDown } = useDisplay();
const session = useSession();
const users = ref<User[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
const inviting = ref(false);
// The user whose two-step verification an administrator is about to reset (R6c).
const resetting = ref<User | null>(null);
const invite = ref({ email: '', role: 'viewer' });
const roles = ['viewer', 'operator', 'admin'];

async function load() {
  loading.value = true;
  try {
    users.value = (await api<{ users: User[] }>('/users')).users;
    error.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function run(label: string, call: () => Promise<unknown>) {
  try {
    await call();
    notice.value = { type: 'success', text: label };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

function resetMfa(user: User) {
  resetting.value = null;
  void run(`The two-step verification of ${user.email} is reset.`, () => api(`/users/${encodeURIComponent(user.email)}/mfa/reset`, { method: 'POST' }));
}

async function sendInvite() {
  const { email, role } = invite.value;
  inviting.value = false;
  try {
    const result = await api<{ invitation: string }>('/users', { method: 'POST', body: JSON.stringify({ email, role }) });
    notice.value = result.invitation === 'sent'
      ? { type: 'success', text: `Invitation sent to ${email}.` }
      : { type: 'info', text: `${email} must first click the verification link that AWS just sent (SES sandbox); then resend the invitation from the user's menu.` };
    invite.value = { email: '', role: 'viewer' };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

const enc = encodeURIComponent;
const headers = [
  { title: 'Email', key: 'email' },
  { title: 'Role', key: 'role' },
  { title: 'Status', key: 'status' },
  { title: 'Two-step', key: 'mfa' },
  { title: 'Created', key: 'createdAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];
const STATUS: Record<string, string> = { CONFIRMED: 'active', FORCE_CHANGE_PASSWORD: 'invited', RESET_REQUIRED: 'password reset' };

// Presentation: the initials on the brand's blue (as the navigation's), each role's color and icon, each state's mark.
const initials = (email: string) => (email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
const ROLE_COLOR: Record<string, string | undefined> = { admin: 'secondary', operator: 'primary' };
const ROLE_ICON: Record<string, string> = { admin: mdiShieldAccountOutline, operator: mdiAccountWrenchOutline, viewer: mdiAccountEyeOutline };
const invited = (u: User) => u.enabled && u.status === 'FORCE_CHANGE_PASSWORD';
const statusMark = (u: User) => {
  if (!u.enabled) return { color: 'error', icon: mdiCancel };
  if (u.status === 'CONFIRMED') return { color: 'success', icon: mdiCheckCircleOutline };
  return { color: 'warning', icon: u.status === 'FORCE_CHANGE_PASSWORD' ? mdiEmailFastOutline : mdiLockReset };
};
const mfaMark = (u: User) => (u.mfa ? { color: 'success', icon: mdiShieldCheckOutline } : u.mfa === null ? { color: 'warning', icon: mdiShieldAlertOutline } : { color: undefined, icon: mdiShieldOffOutline });
const rowProps = ({ item }: { item: User }) => ({ class: { 'dm-row--off': !item.enabled, 'dm-row--invited': invited(item) } });
const exact = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : undefined);
// The team at a glance, above the table: counts of its rows, counting up when they arrive.
const count = (keep: (u: User) => boolean) => users.value.filter(keep).length;
const shown = {
  users: useCountUp(() => users.value.length),
  mfa: useCountUp(() => count((u) => u.mfa === true)),
  invited: useCountUp(() => count(invited)),
  disabled: useCountUp(() => count((u) => !u.enabled)),
};
const tiles = computed(() => [
  { key: 'users', value: shown.users.value, label: users.value.length === 1 ? 'user' : 'users', icon: mdiAccountGroupOutline, color: 'primary' },
  { key: 'mfa', value: shown.mfa.value, label: 'with two-step verification', icon: mdiShieldCheckOutline, color: 'success' },
  { key: 'invited', value: shown.invited.value, label: 'invitations pending', icon: mdiEmailFastOutline, color: 'warning' },
  { key: 'disabled', value: shown.disabled.value, label: 'disabled', icon: mdiAccountCancelOutline, color: 'error' },
]);

load();
</script>

<template>
  <!-- A few rows: a centred column on a wide screen rather than a table spread over it. -->
  <div class="dm-narrow">
    <div class="d-flex flex-wrap align-end ga-4 mb-6">
      <div>
        <div class="dm-eyebrow mb-1">Administration</div>
        <h1 class="text-headline-small">Users</h1>
      </div>
      <v-spacer />
      <v-btn color="primary" variant="flat" :prepend-icon="mdiAccountPlus" @click="inviting = true">Invite</v-btn>
    </div>
    <NoticeAlert v-if="notice" :notice="notice" @close="notice = null" />
    <v-alert v-if="error" type="error" class="mb-4" :text="error" />
    <div v-if="users.length" class="dm-tiles mb-4">
      <v-card v-for="t in tiles" :key="t.key" class="dm-tile">
        <v-card-text class="dm-tile__body">
          <v-avatar :color="t.color" variant="tonal" rounded="lg" size="40"><v-icon :icon="t.icon" size="20" /></v-avatar>
          <div class="dm-tile__text">
            <div class="dm-tile__value">{{ t.value }}</div>
            <div class="dm-tile__label">{{ t.label }}</div>
          </div>
        </v-card-text>
      </v-card>
    </div>
    <v-card class="dm-users">
      <v-data-table :mobile="smAndDown" :headers="headers" :items="users" :loading="loading" item-value="email" :items-per-page="50" :row-props="rowProps">
        <template v-if="!users.length" #loading><DmLoader label="Reading the users…" :size="48" /></template>
        <template #[`item.email`]="{ item }">
          <div class="dm-user">
            <v-avatar size="34" class="dm-avatar" :class="{ 'dm-avatar--invited': invited(item), 'dm-avatar--off': !item.enabled }">{{ initials(item.email) }}</v-avatar>
            <span class="dm-user__email">{{ item.email }}</span>
            <span v-if="item.email === session.email" class="dm-user__you">you</span>
          </div>
        </template>
        <template #[`item.role`]="{ item }">
          <v-chip :color="ROLE_COLOR[item.role]" variant="tonal" label :prepend-icon="ROLE_ICON[item.role]" class="dm-role">{{ item.role }}</v-chip>
        </template>
        <template #[`item.status`]="{ item }">
          <v-chip :color="statusMark(item).color" variant="tonal" label :prepend-icon="statusMark(item).icon">{{ item.enabled ? STATUS[item.status] ?? item.status : 'disabled' }}</v-chip>
        </template>
        <template #[`item.mfa`]="{ item }">
          <span class="dm-mfa" :class="{ 'dm-mfa--off': !mfaMark(item).color }">
            <v-icon :icon="mfaMark(item).icon" :color="mfaMark(item).color" size="18" />{{ item.mfa ? 'on' : item.mfa === null ? 'unknown' : 'off' }}
          </span>
        </template>
        <template #[`item.createdAt`]="{ item }"><span class="dm-num nowrap text-medium-emphasis" :title="exact(item.createdAt)">{{ relative(item.createdAt, now) }}</span></template>
        <template #[`item.actions`]="{ item }">
          <v-menu v-if="item.email !== session.email" location="bottom end">
            <template #activator="{ props }"><v-btn v-bind="props" :icon="mdiDotsVertical" variant="text" size="small" :aria-label="`Actions for ${item.email}`" /></template>
            <v-list density="compact" min-width="250" class="dm-actions">
              <v-list-subheader>Role</v-list-subheader>
              <v-list-item v-for="role in roles.filter((r) => r !== item.role)" :key="role" :title="`Make ${role}`" :prepend-icon="ROLE_ICON[role]"
                @click="run(`${item.email} is now ${role}.`, () => api(`/users/${enc(item.email)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }))" />
              <v-divider class="my-1" />
              <v-list-item v-if="item.status === 'FORCE_CHANGE_PASSWORD'" title="Resend the invitation" :prepend-icon="mdiEmailSyncOutline"
                @click="run(`Invitation sent again to ${item.email}.`, () => api(`/users/${enc(item.email)}/resend`, { method: 'POST' }))" />
              <v-list-item v-if="item.mfa !== false" title="Reset two-step verification" :prepend-icon="mdiShieldRefreshOutline" @click="resetting = item" />
              <v-list-item v-if="item.enabled" title="Disable" base-color="error" :prepend-icon="mdiAccountCancelOutline"
                @click="run(`${item.email} is disabled.`, () => api(`/users/${enc(item.email)}/disable`, { method: 'POST' }))" />
              <v-list-item v-else title="Enable" :prepend-icon="mdiAccountCheckOutline"
                @click="run(`${item.email} is enabled.`, () => api(`/users/${enc(item.email)}/enable`, { method: 'POST' }))" />
            </v-list>
          </v-menu>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="resetting !== null" max-width="460" @update:model-value="resetting = null">
      <v-card :title="`Reset the two-step verification of ${resetting?.email}?`" :prepend-icon="mdiShieldRefreshOutline" class="dm-dialog">
        <v-card-text>Their authenticator app is removed: {{ resetting?.email }} sets up an authenticator app again at their next sign-in. Do it
          only once you know it is them (a lost phone, for example).</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="resetting = null">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="resetMfa(resetting!)">Reset</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="inviting" max-width="460">
      <v-card title="Invite a user" :prepend-icon="mdiAccountPlus" class="dm-dialog">
        <v-card-text>
          <v-text-field v-model="invite.email" label="Email" type="email" autocomplete="off" autofocus />
          <v-select v-model="invite.role" :items="roles" label="Role" />
          <p class="text-body-small text-medium-emphasis">Viewers read, operators also nap and wake workloads, administrators also manage users.</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="inviting = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!invite.email.includes('@')" @click="sendInvite">Invite</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.dm-narrow { max-width: 1120px; margin-inline: auto; }
.dm-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.dm-tile__body { display: flex; align-items: center; gap: 14px; padding: 16px !important; }
.dm-tile__text { min-width: 0; }
.dm-tile__value { font-size: 1.75rem; font-weight: 600; line-height: 1.05; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
.dm-tile__label { margin-top: 2px; font-size: 0.8rem; line-height: 1.25; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
@media (max-width: 960px) { .dm-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .dm-tile__body { gap: 12px; padding: 14px !important; } .dm-tile__value { font-size: 1.5rem; } }
.dm-user { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 6px 0; }
.dm-user__email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dm-user__you { flex: none; padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(var(--v-border-color), 0.2); font: 500 0.62rem/1.4 var(--dm-mono);
  letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
/* The initials on the brand's blue, as the navigation's; an invitation pending: a dashed ring; disabled: greyed. */
.dm-avatar { flex: none; background: linear-gradient(155deg, rgb(69, 137, 202), rgb(3, 75, 128)); color: rgb(255, 255, 255); font-size: 0.72rem; font-weight: 600;
  letter-spacing: 0.02em; transition: filter 0.3s, opacity 0.3s; }
.dm-avatar--invited { background: transparent; color: rgb(var(--v-theme-warning)); border: 1.5px dashed rgba(var(--v-theme-warning), 0.8); }
.dm-avatar--off { filter: grayscale(1); opacity: 0.45; }
.dm-row--off .dm-user__email, .dm-row--off .dm-role { opacity: 0.5; }
.dm-mfa { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; line-height: 1; font-size: 0.875rem; font-weight: 500; }
.dm-mfa--off { color: rgba(var(--v-theme-on-surface), 0.6); }
.dm-num { font-variant-numeric: tabular-nums; }
.dm-users :deep(.v-data-table-rows-loading > td) { height: auto !important; }
.dm-users :deep(.v-data-table-footer) { padding-inline: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
/* One column on a phone: the labels narrow, the values wide. */
.dm-users :deep(.v-data-table__tr--mobile > td) { grid-template-columns: auto minmax(0, 1fr); column-gap: 16px; }
.dm-users :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; }
.dm-dialog :deep(.v-card-title) { white-space: normal; line-height: 1.3; }
.dm-actions :deep(.v-list-subheader) { font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; min-height: 30px; }
</style>
