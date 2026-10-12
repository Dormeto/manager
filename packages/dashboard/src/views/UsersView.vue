<script setup lang="ts">
import { useDisplay } from 'vuetify';
import { ref } from 'vue';
import { mdiAccountPlus, mdiDotsVertical } from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useSession } from '../stores/session';

interface User { email: string; role: string; status: string; enabled: boolean; createdAt: string | null }

const { smAndDown } = useDisplay();
const session = useSession();
const users = ref<User[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
const inviting = ref(false);
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
      <template #[`item.createdAt`]="{ item }">{{ relative(item.createdAt) }}</template>
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
            <v-list-item v-if="item.enabled" title="Disable" base-color="error"
              @click="run(`${item.email} is disabled.`, () => api(`/users/${enc(item.email)}/disable`, { method: 'POST' }))" />
            <v-list-item v-else title="Enable"
              @click="run(`${item.email} is enabled.`, () => api(`/users/${enc(item.email)}/enable`, { method: 'POST' }))" />
          </v-list>
        </v-menu>
      </template>
    </v-data-table>
  </v-card>

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
