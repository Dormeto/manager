<script setup lang="ts">
// A standalone workload's idle signals in a settings form (vision standalone workloads design §4): CPU and network as numbers,
// each with its Off, empty to inherit (the placeholder says what and from where); the custom metric inherited, off, or a
// small form in the level's cloud's shape: AWS's (namespace, name, dimensions with ${resource} offered, statistic, threshold) or
// Google Cloud's (type, an optional filter with ${resource} offered, aligner, threshold). `cloud`: the level's; 'any' at the
// organization's level and in a type, where the person picks the cloud the metric is for. `error`: a refusal of these fields
// (the organization's gate), shown with them.
import { computed, watch } from 'vue';
import { mdiClose, mdiPlus } from '@mdi/js';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from '../cloud-words';
import { EMPTY_GOOGLE, IDLE_METRIC_ALIGNERS, IDLE_METRIC_STATISTICS, standaloneHelp, type IdleForm } from '../idle-settings';
import InfoTip from './InfoTip.vue';

const form = defineModel<IdleForm>({ required: true });
const props = withDefaults(defineProps<{ placeholders: { idleCpuPercent: string; idleNetworkBytes: string; idleMetric: string }; error?: string; cloud?: Cloud | 'any' }>(), { error: '', cloud: 'aws' });
const RESOURCE = '${resource}';
// The cloud the metric is for: the level's, or the one picked.
const shape = computed<Cloud>(() => (props.cloud === 'any' ? form.value.metricCloud ?? 'aws' : props.cloud));
// Google Cloud's fields, added once shown.
watch(shape, (c) => { if (c === 'gcp' && !form.value.gcp) form.value.gcp = { ...EMPTY_GOOGLE }; }, { immediate: true });
const metricCloud = computed({ get: () => shape.value, set: (c: Cloud) => { form.value.metricCloud = c; } });
const helpCloud = computed<Cloud | null>(() => (props.cloud === 'any' ? null : props.cloud));
const words = computed(() => cloudWords(shape.value).standalone);
const CLOUDS = (['aws', 'gcp'] as const).map((c) => ({ title: cloudWords(c).name, value: c }));
const addDimension = () => form.value.metric.dimensions.push({ name: '', value: RESOURCE });
const addResource = () => { const g = form.value.gcp!; g.filter = `${g.filter}${g.filter ? ' ' : ''}${RESOURCE}`; };
</script>

<template>
  <div class="dm-idle-fields">
    <div class="dm-idle-row">
      <v-text-field v-model="form.idleCpuPercent" data-test="idle-cpu" type="number" min="0" max="100" density="compact" label="CPU under (%)" :disabled="form.cpuOff"
        :placeholder="form.cpuOff ? 'Off' : placeholders.idleCpuPercent" persistent-placeholder clearable>
        <template #append-inner><InfoTip label="About CPU" test="idle-cpu">{{ standaloneHelp('idleCpuPercent', helpCloud) }}</InfoTip></template>
      </v-text-field>
      <v-checkbox v-model="form.cpuOff" data-test="idle-cpu-off" label="Off" density="compact" hide-details aria-label="CPU off" />
    </div>
    <div class="dm-idle-row">
      <v-text-field v-model="form.idleNetworkBytes" data-test="idle-network" type="number" min="0" density="compact" label="Network under (bytes a minute)" :disabled="form.networkOff"
        :placeholder="form.networkOff ? 'Off' : placeholders.idleNetworkBytes" persistent-placeholder clearable>
        <template #append-inner><InfoTip label="About Network" test="idle-network">{{ standaloneHelp('idleNetworkBytes', helpCloud) }}</InfoTip></template>
      </v-text-field>
      <v-checkbox v-model="form.networkOff" data-test="idle-network-off" label="Off" density="compact" hide-details aria-label="Network off" />
    </div>
    <v-select v-model="form.metricMode" data-test="idle-metric-mode" density="compact" label="Custom metric"
      :items="[{ title: placeholders.idleMetric, value: 'inherit' }, { title: 'Off', value: 'off' }, { title: cloud === 'any' ? 'A metric' : words.metric, value: 'metric' }]">
      <template #append-inner><InfoTip label="About the custom metric" test="idle-metric">{{ standaloneHelp('idleMetric', shape) }}</InfoTip></template>
    </v-select>
    <div v-if="form.metricMode === 'metric'" class="dm-metric" data-test="idle-metric">
      <template v-if="cloud === 'any'">
        <v-select v-model="metricCloud" data-test="idle-metric-cloud" :items="CLOUDS" label="For the routers of" density="compact" />
        <p data-test="idle-metric-note" class="text-body-small text-medium-emphasis dm-metric__note">A router of the other cloud ignores this metric.</p>
      </template>
      <template v-if="shape === 'gcp' && form.gcp">
        <v-text-field v-model="form.gcp.type" data-test="idle-metric-type" class="dm-metric__wide" label="Metric type" placeholder="custom.googleapis.com/queue/depth" density="compact" />
        <v-text-field v-model="form.gcp.filter" data-test="idle-metric-filter" class="dm-metric__wide" label="Filter (optional)" placeholder="metric.labels.agent = &quot;${resource}&quot;" density="compact"
          :hint="`${RESOURCE} is the resource's name; the filter adds to the metric type's`" persistent-hint>
          <template #append-inner><v-btn size="x-small" variant="tonal" data-test="idle-filter-resource" @click="addResource">{{ RESOURCE }}</v-btn></template>
        </v-text-field>
        <v-select v-model="form.gcp.aligner" data-test="idle-metric-aligner" :items="[...IDLE_METRIC_ALIGNERS]" label="Aligner (each minute)" density="compact" />
        <v-text-field v-model="form.gcp.below" data-test="idle-metric-below" type="number" label="Idle under" density="compact" />
      </template>
      <template v-else>
        <v-text-field v-model="form.metric.namespace" data-test="idle-metric-namespace" label="Namespace" placeholder="AWS/EC2, Custom/Jobs" density="compact" />
        <v-text-field v-model="form.metric.name" data-test="idle-metric-name" label="Metric name" density="compact" />
        <v-select v-model="form.metric.statistic" data-test="idle-metric-statistic" :items="[...IDLE_METRIC_STATISTICS]" label="Statistic" density="compact" />
        <v-text-field v-model="form.metric.below" data-test="idle-metric-below" type="number" label="Idle under" density="compact" />
        <div class="dm-metric__dims">
          <div class="dm-eyebrow mb-1">Dimensions</div>
          <div v-for="(d, i) in form.metric.dimensions" :key="i" class="dm-dim">
            <v-text-field v-model="d.name" :data-test="`idle-dimension-name-${i}`" label="Name" density="compact" hide-details />
            <v-text-field v-model="d.value" :data-test="`idle-dimension-value-${i}`" label="Value" density="compact" hide-details :hint="`${RESOURCE} is the resource's own id`" />
            <v-btn :icon="mdiClose" size="small" variant="text" :aria-label="`Remove the dimension ${d.name || i + 1}`" @click="form.metric.dimensions.splice(i, 1)" />
          </div>
          <v-btn :prepend-icon="mdiPlus" size="small" variant="tonal" data-test="idle-dimension-add" @click="addDimension">Dimension ({{ RESOURCE }})</v-btn>
        </div>
      </template>
    </div>
    <v-alert v-if="error" data-test="idle-problem" type="error" variant="tonal" density="compact" class="mt-2" :text="error" />
  </div>
</template>

<style scoped>
.dm-idle-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.dm-metric { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; padding: 12px; margin-bottom: 8px; border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-metric__dims, .dm-metric__wide, .dm-metric__note { grid-column: 1 / -1; }
.dm-metric__note { margin: -8px 0 12px; }
.dm-dim { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-bottom: 8px; }
@media (max-width: 600px) { .dm-metric, .dm-dim { grid-template-columns: minmax(0, 1fr); } }
</style>
