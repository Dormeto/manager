<script setup lang="ts">
// Rights waiting for two-step verification (R6c): the MFA policy lowers them until the user sets up an authenticator app.
import { useSession } from '../stores/session';

const session = useSession();
</script>

<template>
  <v-alert v-if="session.waitingForMfa" type="warning" variant="tonal" class="mb-4">
    Set up two-step verification to use your {{ session.role }} rights<template v-if="session.effectiveRole === null"> (nothing is shown until then)</template>:
    <router-link to="/account">your Account page</router-link>.
  </v-alert>
</template>
