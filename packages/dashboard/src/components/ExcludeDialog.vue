<script setup lang="ts">
// Exclude a target group, a load balancer or an account from Dormeto: reason and expiry.
import { ref, watch } from 'vue';
import { mdiCancel, mdiInformationOutline } from '@mdi/js';
import { UNTIL_CHOICES, untilFrom, type TargetOption, type UntilChoice } from '../pause';

const props = defineProps<{ modelValue: boolean; options: TargetOption[] }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ target: { kind: string; arn?: string; account?: string }; reason: string; expiresAt?: string }] }>();
const selected = ref(0);
const reason = ref('');
const choice = ref<UntilChoice>('none');
const date = ref('');
watch(() => props.modelValue, (open) => {
  if (!open) return;
  selected.value = 0;
  reason.value = '';
  choice.value = 'none';
  date.value = '';
});

function submit() {
  const option = props.options[selected.value]!;
  const expiresAt = untilFrom(choice.value, Date.now(), date.value);
  const target = option.kind === 'account' ? { kind: option.kind, account: option.account } : { kind: option.kind, arn: option.arn };
  emit('submit', { target, reason: reason.value.trim(), ...(expiresAt ? { expiresAt } : {}) });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card class="dm-dialog">
      <div class="dm-dialog__glow" aria-hidden="true" />
      <v-card-item class="dm-dialog__head">
        <template #prepend>
          <v-avatar color="error" variant="tonal" rounded="lg" size="44"><v-icon :icon="mdiCancel" size="22" /></v-avatar>
        </template>
        <v-card-title class="dm-dialog__title">Exclude from Dormeto</v-card-title>
      </v-card-item>
      <v-card-text class="dm-dialog__body">
        <v-radio-group v-model="selected" label="Exclude" hide-details class="dm-options mb-3">
          <div v-for="(o, i) in options" :key="o.kind" class="dm-option" :class="{ 'dm-option--on': selected === i }">
            <v-radio :value="i" :label="o.label" color="error" />
          </div>
        </v-radio-group>
        <p class="dm-note mb-5">
          <v-icon :icon="mdiInformationOutline" size="18" class="dm-note__icon" />
          <span>Discovery stops proposing it, whatever the perimeter includes. A managed workload it matches is woken and
            never napped; it waits for offboarding.</span>
        </p>
        <v-text-field v-model="reason" label="Reason" maxlength="246" counter autofocus class="mb-1" />
        <v-select v-model="choice" :items="UNTIL_CHOICES.map((c) => (c.value === 'none' ? { ...c, title: 'Never (lift by hand)' } : c))" label="Expires" />
        <v-text-field v-if="choice === 'date'" v-model="date" type="datetime-local" label="Expires at (local time)" />
      </v-card-text>
      <v-card-actions class="dm-dialog__actions">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="error" variant="flat" :disabled="!reason.trim() || (choice === 'date' && !date)" @click="submit">Exclude</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-dialog { position: relative; overflow: hidden; }
/* Readable over the page: the overlay's glass, nearly opaque (the global glass of cards would let the page through). */
.v-card.dm-dialog:not(.v-card--variant-text):not(.v-card--variant-plain) { background: rgba(var(--v-theme-surface), 0.95) !important; }
.dm-dialog__glow { position: absolute; top: -120px; right: -80px; width: 280px; height: 220px; border-radius: 50%; filter: blur(60px); opacity: 0.22; pointer-events: none;
  background: radial-gradient(closest-side, rgb(var(--v-theme-error)), transparent); }
.dm-dialog__head { position: relative; padding: 22px 24px 6px !important; }
.dm-dialog__title { padding: 0 !important; white-space: normal; font-size: 1.2rem !important; line-height: 1.25; }
.dm-dialog__body { position: relative; padding: 14px 24px 8px !important; letter-spacing: 0; }
.dm-dialog__actions { padding: 8px 20px 18px !important; }
.dm-options :deep(.v-input__control > .v-label) { margin-inline-start: 0; font: 500 0.7rem/1.4 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.7; }
.dm-options :deep(.v-selection-control-group) { padding-inline-start: 0 !important; }
.dm-option :deep(.v-selection-control) { min-width: 0; }
.dm-option :deep(.v-label) { white-space: normal; font-weight: 500; line-height: 1.35; padding-block: 6px; }
.dm-option { margin-bottom: 6px; padding: 0 14px 0 6px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 12px; transition: border-color 0.2s, background-color 0.2s; }
.dm-option--on { border-color: rgba(var(--v-theme-error), 0.45); background: rgba(var(--v-theme-error), 0.06); }
.dm-note { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; padding: 12px 14px; font-size: 0.88rem; line-height: 1.5; border-radius: 14px; background: rgba(var(--v-theme-on-surface), 0.04); }
.dm-note__icon { margin-top: 2px; opacity: 0.7; }
@media (prefers-reduced-motion: reduce) { .dm-option { transition: none; } }
</style>
