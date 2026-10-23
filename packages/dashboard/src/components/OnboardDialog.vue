<script setup lang="ts">
// Onboard a discovered candidate: its name (for people; the router derives the workload id from the target group), idle
// window, wake mode, companion databases, fallback instance types (R7b). A Kubernetes candidate (R10.5): what Dormeto adds,
// the GitOps snippet, the router's access to its cluster.
import { computed, ref, watch } from 'vue';
import { mdiCheckCircleOutline, mdiPauseCircleOutline, mdiPencilOutline, mdiPlusCircleOutline, mdiRouterNetwork, mdiUndoVariant } from '@mdi/js';
import { nameRule } from '../format';
import { copiedTags, rowsOf, rowsProblem, tagsOf, type TagRow, type Tags } from '../tags';
import TagsEditor from './TagsEditor.vue';
import { useSession } from '../stores/session';
import { accessText, gitopsSnippet, onboardingTexts, type ClusterAccess, type KubernetesCandidate } from '../kubernetes';

const props = defineProps<{ modelValue: boolean; title: string; defaultName: string | null; kubernetes?: KubernetesCandidate | null; access?: ClusterAccess | null; awsTags?: Record<string, string[]> }>();
const access = computed(() => (props.kubernetes ? accessText(props.kubernetes.cluster, props.access) : null));
const snippet = computed(() => (props.kubernetes ? gitopsSnippet(props.kubernetes) : null));
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ name?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[]; tags?: Tags }] }>();
// Tags at onboarding are the administrators' (the API refuses an operator's).
const session = useSession();
const name = ref('');
const idleMinutes = ref(15);
const wakeMode = ref('any');
const databases = ref('');
// EC2 instances may start on another type when AWS has none of theirs (router 0.25.0); their own type back at the next nap.
const fallbacks = ref('');
// EC2 hibernation (router 0.32.0): inherit the default, or force On or Off for this workload.
const hibernate = ref<'inherit' | 'on' | 'off'>('inherit');
// R11: the workload's own tags (never AWS tags, nothing copied unless asked) that the groups' grants pick workloads by.
const tagRows = ref<TagRow[]>([]);
const copyNote = ref('');
const hasAwsTags = computed(() => Object.keys(props.awsTags ?? {}).length > 0);
const tagsError = computed(() => rowsProblem(tagRows.value));
function copyAws() {
  const { tags, left } = copiedTags(props.awsTags);
  // What the administrator already wrote stays.
  tagRows.value = rowsOf({ ...tags, ...tagsOf(tagRows.value) });
  copyNote.value = left ? `${left} AWS tag${left === 1 ? '' : 's'} left out: reserved or with characters the tags do not allow.` : '';
}
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
  hibernate.value = 'inherit';
  tagRows.value = [];
  copyNote.value = '';
});

// Presentation: an icon per change, in onboardingTexts' order (what the switch adds or patches, the HPA kept, KEDA paused).
const changes = computed(() => {
  const k = props.kubernetes;
  if (!k) return [];
  const icons = [
    k.switch === 'patched-ingress' ? { icon: mdiPencilOutline, color: 'warning' } : { icon: mdiPlusCircleOutline, color: 'success' },
    ...(k.hpa ? [{ icon: mdiCheckCircleOutline, color: 'info' }] : []),
    ...(k.keda ? [{ icon: mdiPauseCircleOutline, color: 'napping' }] : []),
  ];
  return onboardingTexts(k).map((text, i) => ({ text, ...(icons[i] ?? { icon: mdiCheckCircleOutline, color: 'info' }) }));
});

function submit() {
  const list = databases.value.split(',').map((d) => d.trim()).filter(Boolean).map((d) => (d.startsWith('cluster:') ? { kind: 'rds-cluster', id: d.slice(8) } : { kind: 'rds-instance', id: d }));
  emit('submit', { ...(name.value.trim() ? { name: name.value.trim() } : {}), settings: { idleMinutes: Number(idleMinutes.value), wakeMode: wakeMode.value, ...(fallbackTypes.value.length ? { fallbackInstanceTypes: fallbackTypes.value } : {}), ...(!props.kubernetes && hibernate.value !== 'inherit' ? { hibernate: hibernate.value === 'on' } : {}) }, databases: list, ...(session.isAdmin && Object.keys(tagsOf(tagRows.value)).length ? { tags: tagsOf(tagRows.value) } : {}) });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="600" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card class="dm-dialog">
      <div class="dm-dialog__glow" aria-hidden="true" />
      <v-card-item class="dm-dialog__head">
        <template #prepend>
          <v-avatar color="primary" variant="tonal" rounded="lg" size="44"><v-icon :icon="mdiPlusCircleOutline" size="22" /></v-avatar>
        </template>
        <div class="dm-eyebrow">Onboarding</div>
        <v-card-title class="dm-dialog__title">Onboard {{ title }}</v-card-title>
      </v-card-item>
      <v-card-text class="dm-dialog__body">
        <div class="dm-eyebrow mb-2">What changes</div>
        <section class="dm-changes" aria-label="What onboarding changes">
          <ul class="dm-changes__list">
            <template v-if="kubernetes">
              <li v-for="c in changes" :key="c.text" class="dm-change">
                <v-avatar :color="c.color" variant="tonal" size="28"><v-icon :icon="c.icon" size="16" /></v-avatar>
                <span>{{ c.text }}</span>
              </li>
              <li class="dm-change">
                <v-avatar color="primary" variant="tonal" size="28"><v-icon :icon="mdiRouterNetwork" size="16" /></v-avatar>
                <span>The router of its account and region (installed first if needed, with its access entries in the cluster) naps it once idle.</span>
              </li>
            </template>
            <li v-else class="dm-change">
              <v-avatar color="success" variant="tonal" size="28"><v-icon :icon="mdiPlusCircleOutline" size="16" /></v-avatar>
              <span>The router of its account and region (installed first if needed) tags its backends, adds the waker before every rule
                forwarding to its target group (traffic unchanged) and naps it once idle.</span>
            </li>
            <li class="dm-change">
              <v-avatar color="secondary" variant="tonal" size="28"><v-icon :icon="mdiUndoVariant" size="16" /></v-avatar>
              <span>A failed onboarding is undone.</span>
            </li>
          </ul>
        </section>
        <template v-if="kubernetes">
          <v-alert v-if="access" :type="access.level" variant="tonal" density="compact" class="mt-4" :text="access.text" />
          <template v-if="snippet">
            <p class="dm-lead mt-4 mb-2">Its GitOps tool would set the replicas back while it naps: keep this in its configuration.</p>
            <pre data-test="gitops" class="gitops">{{ snippet }}</pre>
          </template>
        </template>
        <div class="dm-eyebrow mt-6 mb-3">Settings</div>
        <v-text-field v-model="name" label="Name" :rules="[nameRule]" counter="64" hint="Shown in the manager; the target group name if empty. It can be changed later." persistent-hint autofocus class="mb-3" />
        <v-row dense>
          <v-col cols="12" sm="5">
            <v-text-field v-model.number="idleMinutes" type="number" label="Idle window (minutes)" min="5" max="1440" />
          </v-col>
          <v-col cols="12" sm="7">
            <v-select v-model="wakeMode" :items="[{ title: 'Any request that passes the filters wakes', value: 'any' }, { title: 'Browser: only the waiter page, the header or a wake rule wakes', value: 'browser' }]" label="Wake mode" />
          </v-col>
        </v-row>
        <v-text-field v-model="databases" label="Companion databases (optional)" hint="RDS instance identifiers, or cluster:<identifier>, comma separated: stopped after the application, started before it" persistent-hint />
        <v-text-field v-if="!kubernetes" v-model="fallbacks" label="Fallback instance types (optional)" :rules="[fallbackRule]" class="mt-4"
          hint="EC2 instances only, comma separated, in order: tried when AWS has no capacity for their own type at a wake; their own type comes back at the next nap" persistent-hint />
        <v-select v-if="!kubernetes" v-model="hibernate" label="Hibernate" class="mt-4" persistent-hint
          :items="[{ title: 'Inherit the default', value: 'inherit' }, { title: 'On', value: 'on' }, { title: 'Off', value: 'off' }]"
          hint="EC2 instances launched with hibernation are hibernated instead of stopped at a nap; with fallback instance types, only if On" />
        <template v-if="session.isAdmin">
        <div class="dm-eyebrow mt-6 mb-1">Tags</div>
        <p class="text-body-small text-medium-emphasis mb-3">Dormeto's own labels for this workload, not AWS tags: the groups' grants pick workloads by them. Administrators can change them later.</p>
        <TagsEditor v-model="tagRows" />
        <v-btn v-if="hasAwsTags" variant="tonal" size="small" class="mb-2" @click="copyAws">Copy the target group's AWS tags</v-btn>
        <p v-if="copyNote" class="text-body-small text-medium-emphasis">{{ copyNote }}</p>
        <v-alert v-if="tagsError" type="error" variant="tonal" density="compact" class="mt-2" :text="tagsError" />
        </template>
      </v-card-text>
      <v-card-actions class="dm-dialog__actions">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="nameRule(name) !== true || fallbackRule() !== true || Boolean(tagsError)" @click="submit">Onboard</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-dialog { position: relative; overflow: hidden; }
/* Readable over the page: the overlay's glass, nearly opaque (the global glass of cards would let the page through). */
.v-card.dm-dialog:not(.v-card--variant-text):not(.v-card--variant-plain) { background: rgba(var(--v-theme-surface), 0.95) !important; }
.dm-dialog__glow { position: absolute; top: -120px; right: -80px; width: 280px; height: 220px; border-radius: 50%; filter: blur(60px); opacity: 0.28; pointer-events: none;
  background: radial-gradient(closest-side, rgb(var(--v-theme-primary)), transparent); }
.dm-dialog__head { position: relative; padding: 22px 24px 6px !important; }
.dm-dialog__title { padding: 2px 0 0 !important; white-space: normal; overflow-wrap: anywhere; font-size: 1.2rem !important; line-height: 1.25; }
.dm-dialog__body { position: relative; padding: 14px 24px 8px !important; letter-spacing: 0; }
.dm-lead { font-size: 0.9rem; line-height: 1.5; }
.dm-dialog__actions { padding: 8px 20px 18px !important; }
.dm-changes { padding: 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 16px; background: rgba(var(--v-theme-on-surface), 0.025); }
.dm-changes__list { list-style: none; display: grid; gap: 12px; margin: 0; padding: 0; }
.dm-change { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 0.9rem; line-height: 1.5; }
.dm-change > span { padding-top: 3px; }
.gitops { font-family: var(--dm-mono); font-size: 0.76rem; line-height: 1.55; white-space: pre; overflow-x: auto; padding: 12px 14px; margin-bottom: 4px; border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), 0.05); }
</style>
