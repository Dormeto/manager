<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { ref } from 'vue';
import { mdiAccountPlus, mdiDotsVertical } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useSession } from '../stores/session';

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

load();
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-4">
    <h1 class="text-headline-small">Users</h1>
    <v-spacer />
    <v-btn color="primary" :prepend-icon="mdiAccountPlus" @click="inviting = true">Invite</v-btn>
  </div>
  <v-alert v-if="notice" :type="notice.type" closable class="mb-4" :text="notice.text" @click:close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card>
    <v-data-table :mobile="smAndDown" :headers="headers" :items="users" :loading="loading" item-value="email" :items-per-page="50">
      <template #[`item.role`]="{ item }"><v-chip :color="item.role === 'admin' ? 'secondary' : item.role === 'operator' ? 'primary' : 'grey'" variant="tonal" label>{{ item.role }}</v-chip></template>
      <template #[`item.status`]="{ item }">
        <v-chip :color="!item.enabled ? 'error' : item.status === 'CONFIRMED' ? 'success' : 'warning'" variant="tonal" label>{{ item.enabled ? STATUS[item.status] ?? item.status : 'disabled' }}</v-chip>
      </template>
      <template #[`item.mfa`]="{ item }"><v-chip :color="item.mfa ? 'success' : item.mfa === null ? 'warning' : 'grey'" variant="tonal" label size="small">{{ item.mfa ? 'on' : item.mfa === null ? 'unknown' : 'off' }}</v-chip></template>
      <template #[`item.createdAt`]="{ item }">{{ relative(item.createdAt, now) }}</template>
      <template #[`item.actions`]="{ item }">
        <v-menu v-if="item.email !== session.email">
          <template #activator="{ props }"><v-btn v-bind="props" :icon="mdiDotsVertical" variant="text" size="small" :aria-label="`Actions for ${item.email}`" /></template>
          <v-list density="compact">
            <v-list-subheader>Role</v-list-subheader>
            <v-list-item v-for="role in roles.filter((r) => r !== item.role)" :key="role" :title="`Make ${role}`"
              @click="run(`${item.email} is now ${role}.`, () => api(`/users/${enc(item.email)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }))" />
            <v-divider />
            <v-list-item v-if="item.status === 'FORCE_CHANGE_PASSWORD'" title="Resend the invitation"
              @click="run(`Invitation sent again to ${item.email}.`, () => api(`/users/${enc(item.email)}/resend`, { method: 'POST' }))" />
            <v-list-item v-if="item.mfa !== false" title="Reset two-step verification" @click="resetting = item" />
            <v-list-item v-if="item.enabled" title="Disable" base-color="error"
              @click="run(`${item.email} is disabled.`, () => api(`/users/${enc(item.email)}/disable`, { method: 'POST' }))" />
            <v-list-item v-else title="Enable"
              @click="run(`${item.email} is enabled.`, () => api(`/users/${enc(item.email)}/enable`, { method: 'POST' }))" />
          </v-list>
        </v-menu>
      </template>
    </v-data-table>
  </v-card>

  <v-dialog :model-value="resetting !== null" max-width="460" @update:model-value="resetting = null">
    <v-card :title="`Reset the two-step verification of ${resetting?.email}?`">
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
    <v-card title="Invite a user">
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
</template>
