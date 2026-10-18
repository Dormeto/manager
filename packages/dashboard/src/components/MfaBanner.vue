<script setup lang="ts">
// Rights waiting for two-step verification (R6c): the MFA policy lowers them until the user sets up an authenticator app
// or, where passkeys are offered, signs in with a passkey.
import { mdiShieldKeyOutline } from '@mdi/js';
import { useSession } from '../stores/session';

const session = useSession();
</script>

<template>
  <v-alert v-if="session.waitingForMfa" type="warning" variant="tonal" class="mb-4 dm-notice">
    <template #prepend><span class="dm-notice__icon"><v-icon :icon="mdiShieldKeyOutline" size="20" /></span></template>
    Set up two-step verification to use your {{ session.role }} rights<template v-if="session.effectiveRole === null"> (nothing is shown until then)</template>:
    <template v-if="session.mfa?.passkeys">set up an authenticator app or add a passkey on </template><router-link to="/account">your Account page</router-link>.
  </v-alert>
</template>

<style scoped>
.dm-notice { border: 1px solid rgba(var(--v-theme-warning), 0.28); align-items: center; }
.dm-notice.v-theme--light :deep(.v-alert__underlay) { opacity: 0.07; }
.dm-notice :deep(.v-alert__content) { color: rgba(var(--v-theme-on-surface), 0.9); line-height: 1.5; }
.dm-notice :deep(.v-alert__prepend) { align-self: center; }
.dm-notice__icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: rgba(var(--v-theme-warning), 0.16); color: rgb(var(--v-theme-warning)); }
.dm-notice a { color: rgb(var(--v-theme-on-surface)); font-weight: 600; text-decoration-color: rgb(var(--v-theme-warning)); text-decoration-thickness: 2px; text-underline-offset: 3px; }
</style>
