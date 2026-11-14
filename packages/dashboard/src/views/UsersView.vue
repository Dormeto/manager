<script setup lang="ts">
import { useNow } from '../now';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  mdiAccountCancelOutline, mdiAccountCheckOutline, mdiAccountEyeOutline, mdiAccountOutline, mdiAccountGroupOutline, mdiAccountMultipleOutline, mdiAccountPlus, mdiAccountWrenchOutline, mdiCancel, mdiCheckCircleOutline,
  mdiEmailFastOutline, mdiEmailSyncOutline, mdiLockReset, mdiShieldAccountOutline, mdiShieldAlertOutline, mdiShieldCheckOutline,
  mdiShieldOffOutline, mdiShieldRefreshOutline,
} from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useSession } from '../stores/session';
import type { DmAction, DmHeader } from '../table';
import DmLoader from '../components/DmLoader.vue';
import DmTable from '../components/DmTable.vue';
import StatusMark from '../components/StatusMark.vue';
import type { Group } from '../groups';
import NoticeAlert from '../components/NoticeAlert.vue';
import { useCountUp } from '../count-up';
import PageTitle from '../components/PageTitle.vue';

// mfa: null when Cognito could not say.
// groups: the custom groups (R11), managed in their own view (Groups); a user's are set here.
interface User { email: string; role: string; status: string; enabled: boolean; createdAt: string | null; mfa?: boolean | null; groups?: string[] }

const now = useNow();
const session = useSession();
const users = ref<User[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
const inviting = ref(false);
// The user whose two-step verification an administrator is about to reset (R6c).
const resetting = ref<User | null>(null);
const invite = ref<{ email: string; role: string; groups: string[] }>({ email: '', role: 'viewer', groups: [] });
const roles = ['viewer', 'operator', 'admin', 'member'];
const roleItems = [{ title: 'Viewer', value: 'viewer' }, { title: 'Operator', value: 'operator' }, { title: 'Administrator', value: 'admin' }, { title: 'Member', value: 'member' }];
// R11: the custom groups' names, and the user whose groups are being set. Group changes travel in the user's token: next sign-in.
const groups = ref<Group[]>([]);
const groupNames = computed(() => groups.value.map((g) => g.name));
const settingGroups = ref<{ user: User; groups: string[] } | null>(null);
// The users holding a group a link names (?group=, a group's members in Groups), until the filter is removed.
const route = useRoute();
const router = useRouter();
const groupFilter = ref('');
watch(() => route.query.group, (name) => { groupFilter.value = typeof name === 'string' ? name : ''; }, { immediate: true });
const listed = computed(() => (groupFilter.value ? users.value.filter((u) => u.groups?.includes(groupFilter.value)) : users.value));
function clearGroupFilter() {
  groupFilter.value = '';
  const { group: _group, ...query } = route.query;
  void router.replace({ query });
}

async function load() {
  loading.value = true;
  try {
    users.value = (await api<{ users: User[] }>('/users')).users;
    error.value = '';
    // The users show without the groups when these cannot be read, and the page says so (the last groups stay).
    try {
      groups.value = (await api<{ groups: Group[] }>('/groups')).groups;
    } catch (err) {
      notice.value = { type: 'error', text: `The groups could not be read: ${(err as Error).message}` };
    }
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
  const { email, role, groups: chosen } = invite.value;
  inviting.value = false;
  try {
    const result = await api<{ invitation: string }>('/users', { method: 'POST', body: JSON.stringify({ email, role, ...(chosen.length ? { groups: chosen } : {}) }) });
    notice.value = result.invitation === 'sent'
      ? { type: 'success', text: `Invitation sent to ${email}.` }
      : { type: 'info', text: `${email} must first click the verification link that AWS just sent (SES sandbox); then resend the invitation from the user's menu.` };
    invite.value = { email: '', role: 'viewer', groups: [] };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

const enc = encodeURIComponent;
function saveGroups() {
  const { user, groups: chosen } = settingGroups.value!;
  settingGroups.value = null;
  void run(`Groups of ${user.email} saved: they apply at their next sign-in, within an hour.`, () => api(`/users/${enc(user.email)}/groups`, { method: 'PUT', body: JSON.stringify({ groups: chosen }) }));
}
const STATUS: Record<string, string> = { CONFIRMED: 'active', FORCE_CHANGE_PASSWORD: 'invited', RESET_REQUIRED: 'password reset' };
// A user's status and two-step verification as their words: the marks' names and tooltips, what search reads and sorts
// on, the exports.
const statusWord = (u: User) => (u.enabled ? STATUS[u.status] ?? u.status : 'disabled');
const mfaWord = (u: User) => (u.mfa ? 'on' : u.mfa === null ? 'unknown' : 'off');
const headers: DmHeader<User>[] = [
  { title: 'Email', key: 'email' },
  { title: 'Role', key: 'role' },
  { title: 'Groups', key: 'groups', sortable: false, text: (u) => (u.groups ?? []).join(', ') },
  { title: 'Status', key: 'status', value: statusWord, text: statusWord },
  { title: 'Two-step', key: 'mfa', value: mfaWord, text: mfaWord },
  { title: 'Created', key: 'createdAt', text: (u) => u.createdAt ?? '' },
];

// Presentation: the initials on the brand's blue (as the navigation's), each role's color and icon, each state's mark.
const initials = (email: string) => (email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
const ROLE_COLOR: Record<string, string | undefined> = { admin: 'secondary', operator: 'primary' };
const ROLE_ICON: Record<string, string> = { admin: mdiShieldAccountOutline, operator: mdiAccountWrenchOutline, viewer: mdiAccountEyeOutline, member: mdiAccountOutline };
const invited = (u: User) => u.enabled && u.status === 'FORCE_CHANGE_PASSWORD';
const statusMark = (u: User) => {
  if (!u.enabled) return { color: 'error', icon: mdiCancel };
  if (u.status === 'CONFIRMED') return { color: 'success', icon: mdiCheckCircleOutline };
  return { color: 'warning', icon: u.status === 'FORCE_CHANGE_PASSWORD' ? mdiEmailFastOutline : mdiLockReset };
};
const mfaMark = (u: User) => (u.mfa ? { color: 'success', icon: mdiShieldCheckOutline } : u.mfa === null ? { color: 'warning', icon: mdiShieldAlertOutline } : { color: undefined, icon: mdiShieldOffOutline });
// A user's menu (not one's own): the role and the groups, then the invitation, the two-step verification, disable or enable.
function actions(u: User): DmAction[] {
  if (u.email === session.email) return [];
  return [
    ...roles.filter((r) => r !== u.role).map((role) => ({
      title: `Make ${role}`, icon: ROLE_ICON[role]!, group: 'Role',
      run: () => void run(`${u.email} is now ${role}.`, () => api(`/users/${enc(u.email)}/role`, { method: 'PUT', body: JSON.stringify({ role }) })),
    })),
    { title: 'Groups…', icon: mdiAccountMultipleOutline, group: 'Role', run: () => { settingGroups.value = { user: u, groups: [...(u.groups ?? [])] }; } },
    ...(u.status === 'FORCE_CHANGE_PASSWORD' ? [{ title: 'Resend the invitation', icon: mdiEmailSyncOutline,
      run: () => void run(`Invitation sent again to ${u.email}.`, () => api(`/users/${enc(u.email)}/resend`, { method: 'POST' })) }] : []),
    ...(u.mfa !== false ? [{ title: 'Reset two-step verification', icon: mdiShieldRefreshOutline, run: () => { resetting.value = u; } }] : []),
    u.enabled
      ? { title: 'Disable', icon: mdiAccountCancelOutline, color: 'error', run: () => void run(`${u.email} is disabled.`, () => api(`/users/${enc(u.email)}/disable`, { method: 'POST' })) }
      : { title: 'Enable', icon: mdiAccountCheckOutline, run: () => void run(`${u.email} is enabled.`, () => api(`/users/${enc(u.email)}/enable`, { method: 'POST' })) },
  ];
}
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
  <div>
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <PageTitle eyebrow="Administration" title="Users" />
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
      <DmTable :headers="headers" :items="listed" :loading="loading" item-value="email" :row-props="rowProps" :actions="actions"
        :exported="{ name: 'users', title: 'Users', filters: groupFilter ? [`Group: ${groupFilter}`] : [] }">
        <template v-if="groupFilter" #toolbar>
          <v-chip data-test="group-filter" closable label variant="tonal" color="primary" :prepend-icon="mdiAccountMultipleOutline" close-label="Show every user" @click:close="clearGroupFilter">Group {{ groupFilter }}</v-chip>
        </template>
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
        <template #[`item.groups`]="{ item }">
          <span class="dm-groups"><v-chip v-for="g in item.groups ?? []" :key="g" data-test="user-group" size="small" label variant="tonal" :to="{ path: '/groups', query: { group: g } }">{{ g }}</v-chip></span>
        </template>
        <template #[`item.status`]="{ item }">
          <StatusMark :icon="statusMark(item).icon" :color="statusMark(item).color" :label="statusWord(item)" />
        </template>
        <template #[`item.mfa`]="{ item }">
          <StatusMark :icon="mfaMark(item).icon" :color="mfaMark(item).color" :label="`Two-step verification ${mfaWord(item)}`">
            <div v-if="item.mfa === null" class="text-body-small">Cognito could not say.</div>
          </StatusMark>
        </template>
        <template #[`item.createdAt`]="{ item }"><span class="dm-num nowrap text-medium-emphasis" :title="exact(item.createdAt)">{{ relative(item.createdAt, now) }}</span></template>
      </DmTable>
    </v-card>

    <v-dialog :model-value="resetting !== null" max-width="460" @update:model-value="resetting = null">
      <v-card :title="`Reset the two-step verification of ${resetting?.email}?`" :prepend-icon="mdiShieldRefreshOutline" class="dm-dialog">
        <v-card-text>Their authenticator app is removed: {{ resetting?.email }} sets up an authenticator app again at their next sign-in. Do it
          only once you know it is them (a lost phone, for example). Passkeys cannot be removed by an administrator: if the user's device with a
          passkey is lost, disable the user.</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="resetting = null">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="resetMfa(resetting!)">Reset</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="settingGroups !== null" max-width="460" @update:model-value="settingGroups = null">
      <v-card v-if="settingGroups" :title="`Groups of ${settingGroups.user.email}`" :prepend-icon="mdiAccountMultipleOutline" class="dm-dialog">
        <v-card-text>
          <v-select v-model="settingGroups.groups" :items="groupNames" label="Groups" multiple chips closable-chips />
          <p class="text-body-small text-medium-emphasis">The groups travel in the user's sign-in token: a change applies at their next sign-in, within an hour.</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="settingGroups = null">Cancel</v-btn>
          <v-btn color="primary" variant="flat" @click="saveGroups">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="inviting" max-width="460">
      <v-card title="Invite a user" :prepend-icon="mdiAccountPlus" class="dm-dialog">
        <v-card-text>
          <v-text-field v-model="invite.email" label="Email" type="email" autocomplete="off" autofocus />
          <v-select v-model="invite.role" :items="roleItems" label="Role" />
          <v-select v-model="invite.groups" :items="groupNames" label="Groups" multiple chips closable-chips :hint="groupNames.length ? undefined : 'No group yet: create one in Groups.'" :persistent-hint="!groupNames.length" />
          <p class="text-body-small text-medium-emphasis">Viewers read, operators also nap and wake workloads, administrators also manage users. A member sees only the workloads their groups
            grant: no built-in role, no group, nothing to see.</p>
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
.dm-num { font-variant-numeric: tabular-nums; }
.dm-groups { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.dm-dialog :deep(.v-card-title) { white-space: normal; line-height: 1.3; }
</style>
