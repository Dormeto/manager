<script setup lang="ts">
// The signed-in user's account (R6c): their role, and two-step verification with an authenticator app (TOTP), set up
// with their access token directly with Cognito.
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { mdiShieldCheckOutline, mdiShieldOffOutline } from '@mdi/js';
import { api } from '../api';
import { accessToken } from '../auth';
import { cognito } from '../cognito';
import { getConfig } from '../config';
import { useSession, type Me } from '../stores/session';

const session = useSession();
const secret = ref('');
const qr = ref('');
const code = ref('');
const busy = ref(false);
const error = ref('');
const issuer = computed(() => `Dormeto ${getConfig().env}`);
const grouped = computed(() => secret.value.replace(/(.{4})/g, '$1 ').trim());
const status = computed(() => {
  if (session.mfa?.enabled) return 'Two-step verification is on: sign-in asks for a code from your authenticator app.';
  if (session.mfa?.required && session.effectiveRole === null) return 'Two-step verification is off: nothing is shown until you set it up.';
  if (session.mfa?.required) return `Two-step verification is off: your ${session.role} rights wait for it (viewer until then).`;
  return 'Two-step verification is off.';
});

async function token(): Promise<string> {
  const t = await accessToken();
  if (!t) throw new Error('your session has expired: sign in again');
  return t;
}

async function step(run: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await run();
  } catch (err) {
    const message = (err as Error).message;
    // Tokens issued before the dashboard asked for the scope keep their scopes when renewed.
    error.value = /required scopes/i.test(message) ? 'Your session predates two-step verification: sign out, sign in again, then set it up.' : message;
  } finally {
    busy.value = false;
  }
}

const start = () => step(async () => {
  const { SecretCode } = await cognito<{ SecretCode: string }>('AssociateSoftwareToken', { AccessToken: await token() });
  secret.value = SecretCode;
  const label = encodeURIComponent(`${issuer.value}:${session.email}`);
  // An SVG image: no canvas needed.
  const svg = await QRCode.toString(`otpauth://totp/${label}?secret=${SecretCode}&issuer=${encodeURIComponent(issuer.value)}`, { type: 'svg', margin: 1, width: 200 });
  qr.value = `data:image/svg+xml;base64,${btoa(svg)}`;
});

const verify = () => step(async () => {
  const AccessToken = await token();
  await cognito('VerifySoftwareToken', { AccessToken, UserCode: code.value.trim(), FriendlyDeviceName: issuer.value });
  await cognito('SetUserMFAPreference', { AccessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } });
  secret.value = '';
  code.value = '';
  session.applyMe(await api<Me>('/me?fresh=1'));
});

// The MFA as Cognito says now: the API caches it (a reset from Users would otherwise show minutes later).
onMounted(async () => {
  try {
    session.applyMe(await api<Me>('/me?fresh=1'));
  } catch {
    // The session's last answer stays.
  }
});

const turnOff = () => step(async () => {
  await cognito('SetUserMFAPreference', { AccessToken: await token(), SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } });
  session.applyMe(await api<Me>('/me?fresh=1'));
});
</script>

<template>
  <h1 class="text-headline-small mb-4">Account</h1>
  <v-row>
    <v-col cols="12" md="7">
      <v-card title="Two-step verification">
        <v-card-text>
          <div class="d-flex align-center ga-2 mb-3">
            <v-icon :icon="session.mfa?.enabled ? mdiShieldCheckOutline : mdiShieldOffOutline" :color="session.mfa?.enabled ? 'success' : 'warning'" />
            <span>{{ status }}</span>
          </div>
          <template v-if="secret">
            <p class="mb-3">Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), or enter the
              key by hand, then type the 6-digit code it shows.</p>
            <div class="d-flex flex-wrap align-center ga-4 mb-3">
              <img :src="qr" alt="QR code of the authenticator secret" width="200" height="200">
              <code class="text-body-large">{{ grouped }}</code>
            </div>
            <v-text-field v-model="code" label="Code from the app" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="max-width: 16rem" @keyup.enter="verify" />
          </template>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" :text="error" class="mt-2" />
        </v-card-text>
        <v-card-actions>
          <v-btn v-if="!session.mfa?.enabled && !secret" color="primary" variant="flat" :loading="busy" @click="start">Set up an authenticator app</v-btn>
          <v-btn v-if="secret" color="primary" variant="flat" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())" @click="verify">Verify</v-btn>
          <v-btn v-if="secret" variant="text" @click="secret = ''">Cancel</v-btn>
          <v-btn v-if="session.mfa?.enabled && session.mfa.mode === 'optional'" variant="text" :loading="busy" @click="turnOff">Turn off</v-btn>
        </v-card-actions>
      </v-card>
    </v-col>
    <v-col cols="12" md="5">
      <v-card title="You">
        <v-card-text>
          <div>{{ session.email }}</div>
          <div class="text-medium-emphasis">Role: {{ session.role }}{{ session.loaded && session.effectiveRole !== session.role ? `, acting as ${session.effectiveRole ?? 'nothing'} until two-step verification is on` : '' }}</div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>
