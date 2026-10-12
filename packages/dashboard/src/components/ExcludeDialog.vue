<script setup lang="ts">
// Exclude a target group, a load balancer or an account from Dormeto: reason and expiry.
import { ref, watch } from 'vue';
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
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card title="Exclude from Dormeto">
      <v-card-text>
        <v-radio-group v-model="selected" label="Exclude" hide-details class="mb-2">
          <v-radio v-for="(o, i) in options" :key="o.kind" :value="i" :label="o.label" />
        </v-radio-group>
        <p class="text-body-medium mb-4">Discovery stops proposing it, whatever the perimeter includes. A managed workload it matches is woken and
          never napped; it waits for offboarding.</p>
        <v-text-field v-model="reason" label="Reason" maxlength="256" counter autofocus />
        <v-select v-model="choice" :items="UNTIL_CHOICES.map((c) => (c.value === 'none' ? { ...c, title: 'Never (lift by hand)' } : c))" label="Expires" />
        <v-text-field v-if="choice === 'date'" v-model="date" type="datetime-local" label="Expires at (local time)" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="error" variant="flat" :disabled="!reason.trim() || (choice === 'date' && !date)" @click="submit">Exclude</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
