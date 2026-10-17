<script setup lang="ts">
// The signed-in user's account (R6c): their role, and two-step verification with an authenticator app (TOTP), set up
// with their access token directly with Cognito.
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { mdiShieldOffOutline } from '@mdi/js';
import { api } from '../api';
import { accessToken } from '../auth';
import { cognito } from '../cognito';
import { getConfig } from '../config';
import { useSession, type Me } from '../stores/session';
import DmLogo from '../components/DmLogo.vue';

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

// Presentation: the initials on the brand's blue (as the navigation's), the role's color (as in Users).
const initials = computed(() => (session.email.split('@')[0] ?? '').split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?');
const ROLE_COLOR: Record<string, string | undefined> = { admin: 'secondary', operator: 'primary' };
</script>

<template>
  <!-- A short page: one centred column, the profile above the two-step verification (side by side, setting it up left an
       empty card beside a tall one). -->
  <div class="dm-account">
    <div class="d-flex flex-wrap align-end ga-4 mb-6">
      <div>
        <div class="dm-eyebrow mb-1">Account</div>
        <h1 class="text-headline-small">Account</h1>
      </div>
    </div>
    <v-card title="You" class="dm-profile mb-4">
      <template #image><div class="dm-profile__sky" aria-hidden="true" /></template>
      <v-card-text class="dm-profile__body">
        <v-avatar size="64" class="dm-avatar">{{ initials }}</v-avatar>
        <div class="dm-profile__who">
          <div class="dm-profile__email">{{ session.email }}</div>
          <div class="dm-profile__role text-medium-emphasis">Role: <v-chip :color="ROLE_COLOR[session.role]" variant="tonal" label size="x-small" class="dm-profile__chip">{{ session.role }}</v-chip><span
            v-if="session.loaded && session.effectiveRole !== session.role" class="text-warning">, acting as {{ session.effectiveRole ?? 'nothing' }} until two-step verification is on</span></div>
        </div>
      </v-card-text>
    </v-card>
    <v-card title="Two-step verification" class="dm-mfa">
      <v-card-text>
        <div class="dm-mfa__status" :class="session.mfa?.enabled ? 'is-on' : 'is-off'">
          <DmLogo v-if="session.mfa?.enabled" state="wake" :size="48" :zzz="false" class="dm-mfa__logo" />
          <v-avatar v-else color="warning" variant="tonal" rounded="lg" size="48"><v-icon :icon="mdiShieldOffOutline" size="22" /></v-avatar>
          <span>{{ status }}</span>
        </div>
        <template v-if="secret">
          <p class="mt-5 mb-4">Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), or enter the
            key by hand, then type the 6-digit code it shows.</p>
          <ol class="dm-steps" role="list">
            <li class="dm-step">
              <span class="dm-step__n" aria-hidden="true">1</span>
              <div class="dm-step__body">
                <div class="dm-step__title">Scan the code, or enter the key by hand</div>
                <div class="dm-scan">
                  <div class="dm-qr"><img :src="qr" alt="QR code of the authenticator secret" width="200" height="200"></div>
                  <div class="dm-key">
                    <div class="dm-key__label">Key</div>
                    <code class="text-body-large">{{ grouped }}</code>
                  </div>
                </div>
              </div>
            </li>
            <li class="dm-step">
              <span class="dm-step__n" aria-hidden="true">2</span>
              <div class="dm-step__body">
                <div class="dm-step__title">Type the 6-digit code the app shows</div>
                <v-text-field v-model="code" label="Code from the app" inputmode="numeric" maxlength="6" autocomplete="one-time-code" class="dm-code" style="max-width: 16rem" @keyup.enter="verify" />
              </div>
            </li>
          </ol>
        </template>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" :text="error" class="mt-4" />
      </v-card-text>
      <v-card-actions class="dm-mfa__actions">
        <v-btn v-if="!session.mfa?.enabled && !secret" color="primary" variant="flat" :loading="busy" @click="start">Set up an authenticator app</v-btn>
        <v-btn v-if="secret" color="primary" variant="flat" :loading="busy" :disabled="!/^\d{6}$/.test(code.trim())" @click="verify">Verify</v-btn>
        <v-btn v-if="secret" variant="text" @click="secret = ''">Cancel</v-btn>
        <v-btn v-if="session.mfa?.enabled && session.mfa.mode === 'optional'" variant="text" :loading="busy" @click="turnOff">Turn off</v-btn>
      </v-card-actions>
    </v-card>
  </div>
</template>

<style scoped>
.dm-account { max-width: 880px; margin-inline: auto; }
.dm-profile__sky { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(70% 90% at 0% 0%, rgba(var(--v-theme-primary), 0.14), transparent 70%), radial-gradient(50% 70% at 100% 100%, rgba(var(--v-theme-secondary), 0.08), transparent 70%); }
.dm-profile__body { display: flex; align-items: center; gap: 18px; padding-top: 8px !important; padding-bottom: 24px !important; }
.dm-profile__who { min-width: 0; }
.dm-profile__email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.05rem; font-weight: 600; letter-spacing: -0.015em; }
.dm-profile__role { margin-top: 4px; line-height: 1.7; }
.dm-profile__chip { margin-left: 2px; vertical-align: 1px; font-family: var(--dm-mono); letter-spacing: 0.04em; }
.dm-avatar { flex: none; background: linear-gradient(155deg, rgb(69, 137, 202), rgb(3, 75, 128)); color: rgb(255, 255, 255); font-size: 1.15rem; font-weight: 600;
  letter-spacing: 0.02em; box-shadow: 0 0 0 4px rgba(var(--v-theme-primary), 0.12), 0 14px 30px -16px rgba(var(--v-theme-primary), 0.9); }

.dm-mfa__status { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 16px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-mfa__status.is-on { border-color: rgba(var(--v-theme-success), 0.28); background: rgba(var(--v-theme-success), 0.07); }
.dm-mfa__status.is-off { border-color: rgba(var(--v-theme-warning), 0.24); background: rgba(var(--v-theme-warning), 0.06); }
.dm-mfa__logo { flex: none; }
.dm-mfa__actions { padding: 0 16px 16px; gap: 8px; }

.dm-steps { display: grid; gap: 20px; margin: 0; padding: 0; list-style: none; }
.dm-step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 14px; }
.dm-step__n { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; font: 600 0.78rem/1 var(--dm-mono);
  color: rgb(var(--v-theme-secondary)); background: rgba(var(--v-theme-secondary), 0.12); border: 1px solid rgba(var(--v-theme-secondary), 0.35); }
.dm-step__title { margin: 3px 0 12px; font-weight: 600; letter-spacing: -0.01em; }
.dm-scan { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; }
/* The QR code on white (as an authenticator app reads it best), in a frame of four corners. */
.dm-qr { position: relative; flex: none; padding: 12px; border-radius: 22px; }
.dm-qr::before { content: ""; position: absolute; inset: 0; border: 2px solid rgb(var(--v-theme-secondary)); border-radius: 22px; pointer-events: none;
  -webkit-mask: linear-gradient(black 0 0) top left / 30px 30px no-repeat, linear-gradient(black 0 0) top right / 30px 30px no-repeat,
    linear-gradient(black 0 0) bottom left / 30px 30px no-repeat, linear-gradient(black 0 0) bottom right / 30px 30px no-repeat;
  mask: linear-gradient(black 0 0) top left / 30px 30px no-repeat, linear-gradient(black 0 0) top right / 30px 30px no-repeat,
    linear-gradient(black 0 0) bottom left / 30px 30px no-repeat, linear-gradient(black 0 0) bottom right / 30px 30px no-repeat; }
.dm-qr img { display: block; width: 176px; height: 176px; padding: 8px; border-radius: 12px; background: white;
  box-shadow: 0 18px 40px -26px rgba(var(--v-theme-night), 0.9); }
.dm-key { min-width: 0; flex: 1 1 14rem; max-width: 20rem; }
.dm-key__label { margin-bottom: 6px; font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
.dm-key code { display: block; padding: 10px 12px; border-radius: 12px; border: 1px dashed rgba(var(--v-border-color), 0.24); background: rgba(var(--v-theme-on-surface), 0.03);
  letter-spacing: 0.08em; word-break: break-word; user-select: all; font-variant-numeric: tabular-nums; }
.dm-code :deep(input) { font-family: var(--dm-mono); font-size: 1.15rem; letter-spacing: 0.3em; font-variant-numeric: tabular-nums; }
@media (max-width: 600px) {
  .dm-step { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .dm-qr img { width: 160px; height: 160px; }
}
</style>
