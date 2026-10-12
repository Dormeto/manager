<script setup lang="ts">
// Onboard a discovered candidate: its name (for people; the router derives the workload id from the target group), idle
// window, wake mode, companion databases, fallback instance types (R7b). A Kubernetes candidate (R10.5): what Dormeto adds,
// the GitOps snippet, the router's access to its cluster.
import { computed, ref, watch } from 'vue';
import { nameRule } from '../format';
import { accessText, gitopsSnippet, onboardingTexts, type ClusterAccess, type KubernetesCandidate } from '../kubernetes';

const props = defineProps<{ modelValue: boolean; title: string; defaultName: string | null; kubernetes?: KubernetesCandidate | null; access?: ClusterAccess | null }>();
const access = computed(() => (props.kubernetes ? accessText(props.kubernetes.cluster, props.access) : null));
const snippet = computed(() => (props.kubernetes ? gitopsSnippet(props.kubernetes) : null));
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ name?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[] }] }>();
const name = ref('');
const idleMinutes = ref(15);
const wakeMode = ref('any');
const databases = ref('');
// EC2 instances may start on another type when AWS has none of theirs (router 0.25.0); their own type back at the next nap.
const fallbacks = ref('');
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\d[a-z0-9-]*\.[a-z0-9]+$/;
const fallbackTypes = computed(() => fallbacks.value.split(',').map((t) => t.trim()).filter(Boolean));
const fallbackRule = () => (fallbackTypes.value.length <= 5 && fallbackTypes.value.every((t) => INSTANCE_TYPE.test(t))) || 'At most 5 EC2 instance types, for example t3a.medium, m6i.large';
watch(() => props.modelValue, (open) => {
  if (!open) return;
  name.value = props.defaultName ?? '';
  idleMinutes.value = 15;
  wakeMode.value = 'any';
  databases.value = '';
  fallbacks.value = '';
});

function submit() {
  const list = databases.value.split(',').map((d) => d.trim()).filter(Boolean).map((d) => (d.startsWith('cluster:') ? { kind: 'rds-cluster', id: d.slice(8) } : { kind: 'rds-instance', id: d }));
  emit('submit', { ...(name.value.trim() ? { name: name.value.trim() } : {}), settings: { idleMinutes: Number(idleMinutes.value), wakeMode: wakeMode.value, ...(fallbackTypes.value.length ? { fallbackInstanceTypes: fallbackTypes.value } : {}) }, databases: list });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Onboard ${title}`">
      <v-card-text>
        <template v-if="kubernetes">
          <p v-for="text in onboardingTexts(kubernetes)" :key="text" class="mb-2">{{ text }}</p>
          <p class="mb-2">The router of its account and region (installed first if needed, with its access entries in the cluster) naps it once idle.
            A failed onboarding is undone.</p>
          <v-alert v-if="access" :type="access.level" variant="tonal" density="compact" class="mb-3" :text="access.text" />
          <template v-if="snippet">
            <p class="mb-1">Its GitOps tool would set the replicas back while it naps: keep this in its configuration.</p>
            <pre data-test="gitops" class="gitops mb-4">{{ snippet }}</pre>
          </template>
        </template>
        <p v-else class="mb-4">The router of its account and region (installed first if needed) tags its backends, adds the waker before every rule
          forwarding to its target group (traffic unchanged) and naps it once idle. A failed onboarding is undone.</p>
        <v-text-field v-model="name" label="Name" :rules="[nameRule]" counter="64" hint="Shown in the manager; the target group name if empty. It can be changed later." persistent-hint autofocus class="mb-2" />
        <v-text-field v-model.number="idleMinutes" type="number" label="Idle window (minutes)" min="5" max="1440" />
        <v-select v-model="wakeMode" :items="[{ title: 'Any request that passes the filters wakes', value: 'any' }, { title: 'Browser: only the waiter page, the header or a wake rule wakes', value: 'browser' }]" label="Wake mode" />
        <v-text-field v-model="databases" label="Companion databases (optional)" hint="RDS instance identifiers, or cluster:<identifier>, comma separated: stopped after the application, started before it" persistent-hint />
        <v-text-field v-if="!kubernetes" v-model="fallbacks" label="Fallback instance types (optional)" :rules="[fallbackRule]" class="mt-2"
          hint="EC2 instances only, comma separated, in order: tried when AWS has no capacity for their own type at a wake; their own type comes back at the next nap" persistent-hint />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="nameRule(name) !== true || fallbackRule() !== true" @click="submit">Onboard</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.gitops { font-family: ui-monospace, monospace; font-size: 0.8rem; white-space: pre; overflow-x: auto; padding: 8px; border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.06); }
</style>
