<script setup lang="ts">
// The defaults of a level (settings at scale design §8, §9): the organization's, a router's or a type's. Each field empty
// to inherit (it says what it gets then), the workloads that follow the level under each, its rules as JSON. Sends only
// what changed, null for a field emptied.
import { computed, ref, watch } from 'vue';
import { mdiTuneVariant } from '@mdi/js';
import { api } from '../api';
import { BUILT_IN, builtInText, defaultsFormOf, type Defaults } from '../defaults';
import { SETTING_KEYS, settingHelp, settingLabel, settingsChanges, type SettingsForm } from '../settings';
import InfoTip from './InfoTip.vue';
import IdleSignalsFields from './IdleSignalsFields.vue';
import type { Cloud } from '@dormeto/fleet/clouds';
import { IDLE_BUILT_IN, idleChanges, idleFormOf, type IdleForm } from '../idle-settings';
import type { IdleSettings } from '../types';

const props = withDefaults(defineProps<{
  modelValue: boolean; title: string; level: 'organization' | 'router' | 'type'; name?: string; values: Defaults;
  // What each field gets when empty, said ("45 min, organization"); the organization's is the built-in value.
  inherited?: Partial<Record<string, string>>; saving?: boolean; error?: string;
  // The level holds the idle signals of its standalone workloads (a router's from 0.42.0, on either cloud).
  idle?: boolean;
  // A router's cloud: its custom metric's shape. The organization's level and a type take either cloud's, picked in the form.
  cloud?: Cloud;
}>(), { name: undefined, inherited: () => ({}), saving: false, error: '', idle: true, cloud: 'aws' });
const metricCloud = computed<Cloud | 'any'>(() => (props.level === 'router' ? props.cloud : 'any'));
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Record<string, unknown>] }>();

const initial = ref<SettingsForm>(defaultsFormOf(props.values));
const form = ref<SettingsForm>({ ...initial.value });
const problem = ref('');
const idleInitial = ref<IdleForm>(idleFormOf(props.values, undefined, props.level === 'router' ? props.cloud : undefined));
const idleForm = ref<IdleForm>(JSON.parse(JSON.stringify(idleInitial.value)) as IdleForm);
// The organization's gate (an idle signal while a router does not know them) and the idle fields' own refusals: shown with them.
const idleError = computed(() => (props.idle && /idle signal/.test(props.error) ? props.error : ''));
const otherError = computed(() => (idleError.value ? '' : props.error));
const idlePlaceholder = (key: keyof IdleSettings) => (props.level === 'organization' ? `Built-in (${IDLE_BUILT_IN[key]})` : props.inherited[key] ? `Inherit (${props.inherited[key]})` : 'Inherit');
const idlePlaceholders = computed(() => ({ idleCpuPercent: idlePlaceholder('idleCpuPercent'), idleNetworkBytes: idlePlaceholder('idleNetworkBytes'), idleMetric: idlePlaceholder('idleMetric') }));
const reach = ref<{ workloads: number; keys: Record<string, number> } | null>(null);
watch(() => props.modelValue, async (open) => {
  if (!open) return;
  initial.value = defaultsFormOf(props.values);
  form.value = { ...initial.value };
  idleInitial.value = idleFormOf(props.values, undefined, props.level === 'router' ? props.cloud : undefined);
  idleForm.value = JSON.parse(JSON.stringify(idleInitial.value)) as IdleForm;
  problem.value = '';
  reach.value = null;
  const query = `level=${props.level}${props.name ? `&name=${encodeURIComponent(props.name)}` : ''}`;
  const answer = await api<{ workloads?: number; keys?: Record<string, number> }>(`/settings/reach?${query}`).catch(() => null);
  // Administrators only, from a manager that counts them: else nothing is said.
  reach.value = typeof answer?.workloads === 'number' && answer.keys ? { workloads: answer.workloads, keys: answer.keys } : null;
}, { immediate: true });

const placeholder = (key: (typeof SETTING_KEYS)[number] | 'wakeMode') => (props.level === 'organization'
  ? `Built-in (${builtInText(key)})`
  : props.inherited[key] ? `Inherit (${props.inherited[key]})` : 'Inherit');
const follows = (key: string) => (reach.value ? `${reach.value.keys[key] ?? 0} of ${reach.value.workloads} workloads follow this level` : '');
const modes = computed(() => [
  { title: placeholder('wakeMode'), value: null },
  { title: 'Any request wakes', value: 'any' },
  { title: 'Browser: the page\'s probe, the header or a wake rule wakes', value: 'browser' },
]);
const scope = computed(() => (props.level === 'organization' ? 'Every workload takes' : props.level === 'router' ? `The workloads of ${props.name} take` : `The workloads of type ${props.name} take`));

function save() {
  const { changes, problem: found } = settingsChanges(initial.value, form.value);
  const idleFound = props.idle ? idleChanges(idleInitial.value, idleForm.value) : { changes: {}, problem: null };
  Object.assign(changes, idleFound.changes);
  problem.value = found ?? idleFound.problem ?? '';
  if (problem.value) return;
  if (!Object.keys(changes).length) {
    emit('update:modelValue', false);
    return;
  }
  emit('submit', changes);
}
defineExpose({ BUILT_IN });
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="640" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="title" data-test="defaults-dialog">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiTuneVariant" size="20" /></v-avatar></template>
      <v-card-text class="pt-3">
        <p class="mb-4 text-body-medium text-medium-emphasis">{{ scope }} these, unless a more specific level sets them. Empty, a field follows the level below.</p>
        <div v-if="idle" class="dm-eyebrow mb-1" data-test="defaults-group">HTTP workloads</div>
        <p v-if="idle" class="text-body-small text-medium-emphasis mb-3">The idle window and the wake timeout apply to standalone workloads too.</p>
        <div class="dm-grid">
          <v-text-field v-for="key in SETTING_KEYS" :key="key" v-model="form[key]" :data-test="`default-${key}`" type="number" density="compact" :label="settingLabel(key)"
            :placeholder="placeholder(key)" persistent-placeholder clearable :hint="follows(key)" persistent-hint>
            <template #append-inner><InfoTip :label="`About ${settingLabel(key)}`" :test="`default-${key}`">{{ settingHelp(key) }}</InfoTip></template>
          </v-text-field>
          <v-select v-model="form.wakeMode" data-test="default-wakeMode" :items="modes" label="Wake mode" density="compact" :hint="follows('wakeMode')" persistent-hint />
        </div>
        <v-textarea v-model="form.noWakeRules" data-test="default-noWakeRules" label="No-wake rules (JSON)" rows="3" auto-grow density="compact" class="dm-json mt-2"
          hint="They add to those of the other levels." persistent-hint />
        <v-textarea v-model="form.wakeRules" data-test="default-wakeRules" label="Wake rules (JSON)" rows="3" auto-grow density="compact" class="dm-json mt-2" />
        <template v-if="idle">
          <div class="dm-eyebrow mt-6 mb-1" data-test="defaults-group">Standalone workloads</div>
          <p class="text-body-small text-medium-emphasis mb-3">Their idle signals: a standalone workload naps when every one that applies stays under its threshold for its idle window.</p>
          <IdleSignalsFields v-model="idleForm" :placeholders="idlePlaceholders" :error="idleError" :cloud="metricCloud" />
        </template>
        <v-alert v-if="problem || otherError" data-test="defaults-problem" type="error" variant="tonal" density="compact" class="mt-3" :text="problem || otherError" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn data-test="save-defaults" color="primary" variant="flat" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; row-gap: 4px; }
.dm-json :deep(textarea) { font-family: var(--dm-mono); font-size: 0.8rem; }
@media (max-width: 600px) { .dm-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
