<script setup lang="ts">
// Onboard a discovered candidate: its name (for people; the router derives the workload id from the target group), idle
// window, wake mode, companion databases, fallback instance types (R7b). A Kubernetes candidate (R10.5): what Dormeto adds,
// the GitOps snippet, the router's access to its cluster. Any other: the lines its Terraform must keep.
// A standalone resource (`resource`, its kind; vision standalone workloads design §6): what a nap does to it, that nothing wakes
// it on demand, its idle signals, and where to give it a schedule.
import { computed, ref, watch } from 'vue';
import { mdiCalendarClock, mdiPowerSleep, mdiCheckCircleOutline, mdiPauseCircleOutline, mdiPencilOutline, mdiPlusCircleOutline, mdiRouterNetwork, mdiUndoVariant } from '@mdi/js';
import { GOOGLE_ROUTER_MINIMUM } from '@dormeto/fleet/clouds';
import { cloudWords } from '../cloud-words';
import { nameRule } from '../format';
import { copiedTags, rowsOf, rowsProblem, tagsOf, type TagRow, type Tags } from '../tags';
import TagsEditor from './TagsEditor.vue';
import { useSession } from '../stores/session';
import { accessText, gitopsSnippet, onboardingTexts, type ClusterAccess, type KubernetesCandidate } from '../kubernetes';
import { terraformSnippet } from '../terraform';
import type { ResourceKind } from '@dormeto/discovery/types';
import { idleChanges, idleFormOf, type IdleForm } from '../idle-settings';
import IdleSignalsFields from './IdleSignalsFields.vue';

// On Google Cloud (`cloud`): the candidate's labels come in `awsTags` (the candidate's `tags`), and `routers` are the project's routers
// of 0.40.0 and later a `global` candidate may go through, null while they are read (Onboard waits). One is asked for when
// several are offered or the API needs one named (`chooseRouter`: the project has several, whatever their versions), the only
// one offered then chosen already.
const props = defineProps<{ modelValue: boolean; title: string; defaultName: string | null; kubernetes?: KubernetesCandidate | null; access?: ClusterAccess | null; awsTags?: Record<string, string[]>; backendKind?: string | null; cloud?: 'aws' | 'gcp'; routers?: { name: string; region: string }[] | null; chooseRouter?: boolean; resource?: ResourceKind | null }>();
// What a nap and a wake do to a standalone resource, by its kind (the router's backend modules), in its cloud's words.
const napText = computed(() => (props.resource ? cloudWords(props.cloud).standalone.naps[props.resource] ?? '' : ''));
// Its idle signals, each inherited unless set here.
const idleInitial = idleFormOf({});
const idle = ref<IdleForm>(JSON.parse(JSON.stringify(idleInitial)) as IdleForm);
const idleProblem = ref('');
// Inherit alone: a type, the router or the organization may replace a built-in, which the dialog cannot know before the
// router resolves them (the review's M13); the line below the fields says it.
const idlePlaceholders = { idleCpuPercent: 'Inherit', idleNetworkBytes: 'Inherit', idleMetric: 'Inherit' };
const gcp = computed(() => props.cloud === 'gcp');
const words = computed(() => cloudWords(props.cloud));
const waiting = computed(() => gcp.value && props.routers === null);
const several = computed(() => gcp.value && (Boolean(props.chooseRouter) || (props.routers?.length ?? 0) > 1));
const router = ref<string | null>(null);
const preselect = () => {
  if (several.value && !router.value && props.routers?.length === 1) router.value = props.routers[0]!.name;
};
watch(() => props.routers, preselect);
const access = computed(() => (props.kubernetes ? accessText(props.kubernetes.cluster, props.access) : null));
const snippet = computed(() => (props.kubernetes ? gitopsSnippet(props.kubernetes) : null));
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ name?: string; router?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[]; tags?: Tags }] }>();
// Tags at onboarding are the administrators' (the API refuses an operator's).
const session = useSession();
const name = ref('');
// Empty: the levels decide (settings at scale design §9), and nothing is sent.
const idleMinutes = ref<number | string | null>(null);
const wakeMode = ref<string | null>(null);
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
  copyNote.value = left ? `${left} ${words.value.tag}${left === 1 ? '' : 's'} left out: reserved or with characters the tags do not allow.` : '';
}
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\d[a-z0-9-]*\.[a-z0-9]+$/;
// The router's pattern for a Compute Engine machine type.
const MACHINE_TYPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const fallbackTypes = computed(() => fallbacks.value.split(',').map((t) => t.trim()).filter(Boolean));
// A standalone resource has no Terraform lines to keep (no rule nor waker is added).
const noTerraform = computed(() => Boolean(props.resource));
const terraform = computed(() => (noTerraform.value ? null : props.kubernetes || gcp.value ? null : terraformSnippet(props.backendKind, fallbackTypes.value.length > 0)));
// Fallback types for EC2 capacity: an instance's outside a group, or a group's; hibernation: an instance's outside a group.
const takesFallbacks = computed(() => (props.resource ? props.resource === 'instance' || props.resource === 'asg' : gcp.value || !props.kubernetes));
const takesHibernate = computed(() => (props.resource ? props.resource === 'instance' : gcp.value || !props.kubernetes));
const fallbackRule = () => (fallbackTypes.value.length <= 5 && new Set(fallbackTypes.value).size === fallbackTypes.value.length && fallbackTypes.value.every((t) => (gcp.value ? MACHINE_TYPE : INSTANCE_TYPE).test(t)))
  || words.value.fallbacksRule;
watch(() => props.modelValue, (open) => {
  if (!open) return;
  name.value = props.defaultName ?? '';
  idleMinutes.value = null;
  wakeMode.value = null;
  databases.value = '';
  fallbacks.value = '';
  hibernate.value = 'inherit';
  router.value = null;
  preselect();
  tagRows.value = [];
  copyNote.value = '';
  idle.value = JSON.parse(JSON.stringify(idleInitial)) as IdleForm;
  idleProblem.value = '';
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
  const idleFound = props.resource ? idleChanges(idleInitial, idle.value) : { changes: {}, problem: null };
  idleProblem.value = idleFound.problem ?? '';
  if (idleFound.problem) return;
  const list = databases.value.split(',').map((d) => d.trim()).filter(Boolean).map((d) => (gcp.value ? { kind: 'cloudsql-instance', id: d } : d.startsWith('cluster:') ? { kind: 'rds-cluster', id: d.slice(8) } : { kind: 'rds-instance', id: d }));
  emit('submit', { ...(name.value.trim() ? { name: name.value.trim() } : {}), ...(several.value && router.value ? { router: router.value } : {}), settings: { ...(idleMinutes.value === null || idleMinutes.value === '' ? {} : { idleMinutes: Number(idleMinutes.value) }), ...(wakeMode.value ? { wakeMode: wakeMode.value } : {}), ...(fallbackTypes.value.length ? { fallbackInstanceTypes: fallbackTypes.value } : {}), ...(takesHibernate.value && hibernate.value !== 'inherit' ? { hibernate: hibernate.value === 'on' } : {}), ...idleFound.changes }, databases: list, ...(session.isAdmin && Object.keys(tagsOf(tagRows.value)).length ? { tags: tagsOf(tagRows.value) } : {}) });
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
            <template v-else-if="resource">
              <li class="dm-change" data-test="onboard-standalone">
                <v-avatar color="success" variant="tonal" size="28"><v-icon :icon="mdiPlusCircleOutline" size="16" /></v-avatar>
                <span>{{ words.standalone.onboards }}</span>
              </li>
              <li class="dm-change" data-test="onboard-standalone">
                <v-avatar color="info" variant="tonal" size="28"><v-icon :icon="mdiPauseCircleOutline" size="16" /></v-avatar>
                <span>{{ napText }}</span>
              </li>
              <li class="dm-change" data-test="onboard-standalone">
                <v-avatar color="warning" variant="tonal" size="28"><v-icon :icon="mdiCalendarClock" size="16" /></v-avatar>
                <span>Nothing wakes it on demand: a schedule, a person or {{ words.standalone.startOutside }} does.</span>
              </li>
              <li class="dm-change" data-test="onboard-standalone">
                <v-avatar color="secondary" variant="tonal" size="28"><v-icon :icon="mdiPowerSleep" size="16" /></v-avatar>
                <span>It naps on a schedule, on a person's word, or when its idle signals stay under their thresholds.</span>
              </li>
              <li class="dm-change">
                <span aria-hidden="true" />
                <span><router-link data-test="onboard-schedule" to="/schedules" class="dm-link">Give it a schedule</router-link> once onboarded, in Schedules.</span>
              </li>
            </template>
            <template v-else-if="gcp">
              <li class="dm-change">
                <v-avatar color="success" variant="tonal" size="28"><v-icon :icon="mdiPlusCircleOutline" size="16" /></v-avatar>
                <span>The router of its project and region adds the waker to its backend service's routing in the URL map (traffic unchanged) and naps it once idle.</span>
              </li>
              <li class="dm-change">
                <v-avatar color="info" variant="tonal" size="28"><v-icon :icon="mdiCheckCircleOutline" size="16" /></v-avatar>
                <span>The manager binds the tag <code>dormeto/managed</code> to the VMs, managed instance groups and Cloud SQL instances the preview names, and removes the bindings it made when the router refuses.</span>
              </li>
            </template>
            <li v-else class="dm-change">
              <v-avatar color="success" variant="tonal" size="28"><v-icon :icon="mdiPlusCircleOutline" size="16" /></v-avatar>
              <span>The router of its account and region (installed first if needed) tags its backends, adds the waker before every rule
                forwarding to its target group (traffic unchanged) and naps it once idle. A rule it cannot cover, such as one that acts before its forward, gets the waker itself: the operation's steps name it.</span>
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
        <template v-if="terraform">
          <p class="dm-lead mt-4 mb-2">If Terraform writes these resources, keep this in its configuration: an apply would otherwise remove what onboarding adds, until the router repairs it.</p>
          <pre data-test="terraform" class="gitops">{{ terraform }}</pre>
        </template>
        <div class="dm-eyebrow mt-6 mb-3">Settings</div>
        <v-text-field v-model="name" label="Name" :rules="[nameRule]" counter="64" :hint="resource ? 'Shown in the manager; the resource\'s name if empty. It can be changed later.' : `Shown in the manager; the ${words.target} name if empty. It can be changed later.`" persistent-hint autofocus class="mb-3" />
        <v-row dense>
          <v-col cols="12" sm="5">
            <v-text-field v-model="idleMinutes" type="number" label="Idle window (minutes)" min="5" max="1440" :placeholder="'Inherit'" persistent-placeholder clearable />
          </v-col>
          <v-col v-if="!resource" cols="12" sm="7">
            <v-select v-model="wakeMode" data-test="onboard-wakeMode" :items="[{ title: 'Inherit', value: null }, { title: 'Any request that passes the filters wakes', value: 'any' }, { title: 'Browser: only the waiter page, the header or a wake rule wakes', value: 'browser' }]" label="Wake mode" />
          </v-col>
        </v-row>
        <template v-if="resource">
          <div class="dm-eyebrow mt-2 mb-2">Idle signals</div>
          <IdleSignalsFields v-model="idle" :placeholders="idlePlaceholders" :error="idleProblem" :cloud="cloud ?? 'aws'" />
          <p data-test="onboard-inherit" class="text-body-small text-medium-emphasis mt-1">Empty settings take the levels' (a type, the router, the organization); with none set, the built-ins: {{ words.standalone.inherit }}.</p>
        </template>
        <v-select v-if="several" v-model="router" :items="(routers ?? []).map((r) => ({ title: `${r.name} (${r.region})`, value: r.name }))" label="Router" class="mb-3" persistent-hint
          :hint="routers?.length ? (resource ? 'The project has several routers and none in the resource\'s region: this one serves the workload' : 'The project has several routers: this one serves the workload (a global load balancer has no region of its own)') : `No router of the project is ${GOOGLE_ROUTER_MINIMUM} or later: upgrade one with dormeto gcp routers install`" />
        <v-text-field v-model="databases" :label="words.databasesLabel" :hint="words.databasesHint" persistent-hint />
        <!-- Fallback types and hibernation: on Google Cloud always, on AWS but for a Kubernetes candidate. -->
        <v-text-field v-if="takesFallbacks" v-model="fallbacks" :label="`Fallback ${words.types} (optional)`" :rules="[fallbackRule]" class="mt-4" :hint="words.fallbacksHint" persistent-hint />
        <v-select v-if="takesHibernate" v-model="hibernate" :label="words.hibernate" class="mt-4" persistent-hint
          :items="[{ title: 'Inherit the default', value: 'inherit' }, { title: 'On', value: 'on' }, { title: 'Off', value: 'off' }]" :hint="words.hibernateHint" />
        <template v-if="session.isAdmin">
        <div class="dm-eyebrow mt-6 mb-1">Tags</div>
        <p class="text-body-small text-medium-emphasis mb-3">Dormeto's own labels for this workload, not {{ words.tags }}: the groups' grants pick workloads by them. Administrators can change them later.</p>
        <TagsEditor v-model="tagRows" />
        <v-btn v-if="hasAwsTags" variant="tonal" size="small" class="mb-2" @click="copyAws">{{ words.copyTags }}</v-btn>
        <p v-if="copyNote" class="text-body-small text-medium-emphasis">{{ copyNote }}</p>
        <v-alert v-if="tagsError" type="error" variant="tonal" density="compact" class="mt-2" :text="tagsError" />
        </template>
      </v-card-text>
      <v-card-actions class="dm-dialog__actions">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="nameRule(name) !== true || fallbackRule() !== true || Boolean(tagsError) || waiting || (several && !router)" @click="submit">Onboard</v-btn>
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
/* The dashboard's link (not the browser's blue). */
.dm-link { color: rgb(var(--v-theme-primary)); font-weight: 500; text-decoration: none; }
.dm-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-link:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.gitops { font-family: var(--dm-mono); font-size: 0.76rem; line-height: 1.55; white-space: pre; overflow-x: auto; padding: 12px 14px; margin-bottom: 4px; border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), 0.05); }
</style>
