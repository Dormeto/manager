<script setup lang="ts">
// The Google Cloud connection, read-only (administrators and viewers read it): what `dormeto gcp connect` recorded, or the
// command that connects one. The CLI changes the project's IAM policy; the manager only shows what it did.
import { mdiGoogleCloud } from '@mdi/js';
import { relative } from '../format';
import { useNow } from '../now';
import type { GoogleConnection } from '../types';

// connection: null when there is none; error: why it could not be read (then neither is said).
defineProps<{ connection: GoogleConnection | null; error?: string }>();
const now = useNow();
</script>

<template>
  <v-card data-test="google-connection" class="mb-4">
    <v-card-item class="dm-head">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiGoogleCloud" size="20" /></v-avatar></template>
      <v-card-title>Google Cloud connection</v-card-title>
      <v-card-subtitle class="text-wrap">Set by <code>dormeto gcp connect</code> and removed by <code>dormeto gcp disconnect</code>; read-only here</v-card-subtitle>
    </v-card-item>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <v-card-text v-else-if="!connection" class="text-medium-emphasis">
      No Google Cloud connection: the manager reaches no Google Cloud router. Run <code>dormeto gcp connect --project &lt;host project&gt; --profile &lt;profile&gt; --env &lt;env&gt;</code> to connect one.
    </v-card-text>
    <template v-else>
      <v-table density="compact" class="dm-conn">
        <tbody>
          <tr><th>Host project</th><td><span class="mono">{{ connection.project }}</span> <span class="text-medium-emphasis">({{ connection.projectNumber }})</span></td></tr>
          <tr><th>Scopes</th><td><div v-for="s in connection.scopes" :key="s" class="mono">{{ s }}</div></td></tr>
          <tr><th>Discovery account</th><td class="mono">{{ connection.serviceAccounts.discovery }}</td></tr>
          <tr><th>Command account</th><td class="mono">{{ connection.serviceAccounts.command }}</td></tr>
          <tr><th>Workload identity</th><td><span class="mono">{{ connection.pool }}</span> <span class="text-medium-emphasis">(provider {{ connection.provider }})</span></td></tr>
          <tr><th>Routers</th>
            <td>
              <div v-for="r in connection.routers" :key="`${r.project}/${r.region}`"><span class="mono">{{ r.project }}</span> · <span class="mono">{{ r.region }}</span><span v-if="r.version" class="text-medium-emphasis"> · {{ r.version }}</span></div>
              <span v-if="!connection.routers.length" class="text-medium-emphasis">none yet: <code>dormeto gcp install</code>, then <code>dormeto gcp connect</code> again</span>
            </td></tr>
        </tbody>
      </v-table>
      <v-card-text class="text-body-small text-medium-emphasis">Connected {{ relative(connection.connectedAt, now) }} by {{ connection.connectedBy }}<template v-if="connection.cli"> with CLI {{ connection.cli }}</template></v-card-text>
    </template>
  </v-card>
</template>

<style scoped>
.dm-conn th { width: 11rem; text-align: left; font-weight: 400; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); vertical-align: top; }
.dm-conn td { overflow-wrap: anywhere; }
</style>
