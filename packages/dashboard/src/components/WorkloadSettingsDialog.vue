<script setup lang="ts">
// A manager workload's own settings (settings at scale design §9): each one empty to inherit (the field says the value it
// gets now and from where) or its own value; its wake mode and type alike; its own rules as JSON. Sends only what changed.
// A standalone workload's (vision standalone workloads design §4): its idle window, wake timeout, type and idle signals, no
// waker's setting.
import { computed, ref, watch } from 'vue';
import { mdiTuneVariant } from '@mdi/js';
import { formOf, settingRows, settingsChanges, sourceText, typeText, type SettingsForm } from '../settings';
import type { IdleSettings, WorkloadStatus } from '../types';
import { idleChanges, idleFormOf, standaloneSettingRows, standaloneValue, type IdleForm } from '../idle-settings';
import IdleSignalsFields from './IdleSignalsFields.vue';
import { rowCloud } from '../format';
import InfoTip from './InfoTip.vue';

const props = withDefaults(defineProps<{
  modelValue: boolean; subject: string; status: Pick<WorkloadStatus, 'settings' | 'wakeMode' | 'settingsFrom' | 'type' | 'noWakeRules' | 'wakeRules' | 'kind' | 'cloud' | 'account'>;
  types?: string[]; saving?: boolean; error?: string;
}>(), { types: () => [], saving: false, error: '' });
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Record<string, unknown>] }>();

const initial = ref<SettingsForm>(formOf(props.status));
const form = ref<SettingsForm>({ ...initial.value });
const problem = ref('');
const standalone = computed(() => props.status.kind === 'standalone');
const ownIdle = (key: keyof IdleSettings) => props.status.settingsFrom?.[key] === 'workload';
// Its cloud: its metric's shape and its helps' words.
const cloud = computed(() => rowCloud(props.status));
const idleInitial = ref<IdleForm>(idleFormOf(props.status.settings, ownIdle, cloud.value));
const idle = ref<IdleForm>(JSON.parse(JSON.stringify(idleInitial.value)) as IdleForm);
watch(() => props.modelValue, (open) => {
  if (!open) return;
  initial.value = formOf(props.status);
  form.value = { ...initial.value };
  idleInitial.value = idleFormOf(props.status.settings, ownIdle, cloud.value);
  idle.value = JSON.parse(JSON.stringify(idleInitial.value)) as IdleForm;
  problem.value = '';
});
// What an idle signal gets when empty.
const idlePlaceholders = computed(() => {
  const at = (key: keyof IdleSettings) => {
    const value = standaloneValue(key, props.status.settings);
    return value ? inheritText(key as keyof SettingsForm, value) : 'Inherit';
  };
  return { idleCpuPercent: at('idleCpuPercent'), idleNetworkBytes: at('idleNetworkBytes'), idleMetric: at('idleMetric') };
});

// What each field gets when left empty: the value in force when it is inherited now, else just "Inherit".
// A standalone workload's idle window and wake timeout explained as its kind's, in its cloud's words.
const rows = computed(() => {
  const base = settingRows(props.status.settings, props.status.settingsFrom, cloud.value);
  if (!standalone.value) return base;
  const own = standaloneSettingRows(props.status.settings, props.status.settingsFrom, cloud.value);
  return base.map((r) => ({ ...r, ...((o) => (o ? { help: o.help, range: o.range } : {}))(own.find((x) => x.key === r.key)) }));
});
const inheritText = (key: keyof SettingsForm, value: string) => {
  const from = props.status.settingsFrom?.[key as keyof NonNullable<WorkloadStatus['settingsFrom']>];
  return from && from !== 'workload' ? `Inherit (${value}, ${sourceText(from, props.status.type)})` : 'Inherit';
};
const modes = computed(() => [
  { title: inheritText('wakeMode', props.status.wakeMode), value: null },
  { title: 'Any request wakes', value: 'any' },
  { title: 'Browser: the page\'s probe, the header or a wake rule wakes', value: 'browser' },
]);
const typeChoices = computed(() => [
  { title: props.status.type?.from && props.status.type.from !== 'workload' ? `Inherit (${typeText(props.status.type)})` : 'Inherit', value: null },
  ...props.types.map((name) => ({ title: name, value: name })),
]);

function save() {
  const { changes, problem: found } = settingsChanges(initial.value, form.value);
  const idleFound = standalone.value ? idleChanges(idleInitial.value, idle.value) : { changes: {}, problem: null };
  Object.assign(changes, idleFound.changes);
  problem.value = found ?? idleFound.problem ?? '';
  if (problem.value) return;
  if (!Object.keys(changes).length) {
    emit('update:modelValue', false);
    return;
  }
  emit('submit', changes);
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="640" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Settings of ${subject}`" data-test="settings-dialog">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiTuneVariant" size="20" /></v-avatar></template>
      <v-card-text class="pt-3">
        <p class="mb-4 text-body-medium text-medium-emphasis">Empty, a setting follows the workload's type, its router, then the organization.</p>
        <div class="dm-grid">
          <v-text-field v-for="row in rows" :key="row.key" v-model="form[row.key]" :data-test="`setting-${row.key}`" type="number" density="compact" :label="row.label"
            :placeholder="inheritText(row.key, row.value)" persistent-placeholder clearable>
            <template #append-inner><InfoTip :label="`About ${row.label}`" :test="`setting-${row.key}`">{{ row.help }} {{ row.range }}</InfoTip></template>
          </v-text-field>
          <v-select v-if="!standalone" v-model="form.wakeMode" data-test="setting-wakeMode" :items="modes" label="Wake mode" density="compact" />
          <v-select v-model="form.type" data-test="setting-type" :items="typeChoices" label="Type" density="compact" />
        </div>
        <template v-if="standalone">
          <div class="dm-eyebrow mt-2 mb-2">Idle signals</div>
          <p class="text-body-small text-medium-emphasis mb-3">It naps when every signal that applies stays under its threshold for its idle window; Off turns an inherited signal off.</p>
          <IdleSignalsFields v-model="idle" :placeholders="idlePlaceholders" :cloud="cloud" />
        </template>
        <template v-else>
        <v-textarea v-model="form.noWakeRules" data-test="setting-noWakeRules" label="No-wake rules of this workload (JSON)" rows="3" auto-grow density="compact" class="dm-json"
          hint="Those of its type, router and organization apply too." persistent-hint />
        <v-textarea v-model="form.wakeRules" data-test="setting-wakeRules" label="Wake rules of this workload (JSON)" rows="3" auto-grow density="compact" class="dm-json mt-2" />
        </template>
        <v-alert v-if="problem || error" data-test="settings-problem" type="error" variant="tonal" density="compact" class="mt-3" :text="problem || error" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn data-test="save-settings" color="primary" variant="flat" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; }
.dm-json :deep(textarea) { font-family: var(--dm-mono); font-size: 0.8rem; }
@media (max-width: 600px) { .dm-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
