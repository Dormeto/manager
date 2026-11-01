<script setup lang="ts">
// Edit the waiting page of one level: a template (icon, title, description) or, for administrators, the customer's own HTML,
// with a live preview of the real renderer (a sandboxed frame, no script) in each state, language and color scheme. A chosen
// file is checked by its bytes and size before anything is sent; the API and the router check again.
import { computed, ref, watch } from 'vue';
import { useDisplay, useTheme } from 'vuetify';
import { mdiImageOutline } from '@mdi/js';
import {
  DESCRIPTION_MAX, PAGE_STATES, TITLE_MAX, checkHtml, checkIcon, fromLine, htmlSizeProblem, htmlWarnings, iconSizeProblem, previewHtml, resolveDraft, templateAbove,
  type EffectivePage, type PageLevel, type PageState, type StoredPage, type TemplatePage,
} from '../waiting-page';
import WaitingPagePreview from './WaitingPagePreview.vue';

type IconChoice = 'inherit' | 'auto' | 'upload' | 'none';
const props = defineProps<{
  modelValue: boolean; level: PageLevel; subject: string; own: StoredPage | null; inherited: EffectivePage; beneath?: EffectivePage | null; favicon: string | null;
  canCustom: boolean; saving?: boolean; error?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [StoredPage] }>();
const { smAndDown } = useDisplay();
const theme = useTheme();

const mode = ref<'template' | 'custom'>('template');
const icon = ref<IconChoice>('inherit');
const uploaded = ref<string | null>(null);
const iconProblem = ref('');
const iconTouched = ref(false);
const title = ref('');
const description = ref('');
const html = ref('');
const htmlProblem = ref('');
const state = ref<PageState>('waking');
const language = ref<'en' | 'fr'>('en');
const dark = ref(false);
// The refusal of this opening's attempts only: the parent keeps the last one until its next write.
const shownError = ref('');
watch(() => props.error, (error) => { shownError.value = error ?? ''; });
// Inheriting the icon needs a level above: the organization's is automatic unless it says otherwise.
const inheritable = computed(() => props.level !== 'organization');
watch(() => props.modelValue, (open) => {
  if (!open) return;
  const own = props.own;
  mode.value = own?.mode === 'custom' && props.canCustom ? 'custom' : 'template';
  const template = own?.mode === 'template' ? own : null;
  icon.value = !template?.icon ? (inheritable.value ? 'inherit' : 'auto') : template.icon === 'auto' || template.icon === 'none' ? template.icon : 'upload';
  uploaded.value = template?.icon?.startsWith('data:') ? template.icon : null;
  title.value = template?.title ?? '';
  description.value = template?.description ?? '';
  html.value = own?.mode === 'custom' ? own.html : '';
  iconProblem.value = '';
  iconTouched.value = false;
  htmlProblem.value = '';
  shownError.value = props.error ?? '';
  state.value = 'waking';
  dark.value = theme.current.value.dark;
}, { immediate: true });

const first = (value: File | File[] | null | undefined): File | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);
// The newest choice wins, whatever order the reads finish in.
let choice = 0;
async function read(file: File, tooBig: (size: number) => string): Promise<{ bytes: Uint8Array } | { problem: string }> {
  const big = tooBig(file.size);
  if (big) return { problem: big };
  try {
    return { bytes: new Uint8Array(await file.arrayBuffer()) };
  } catch {
    return { problem: 'The file could not be read.' };
  }
}
async function chooseIcon(value: File | File[] | null) {
  const file = first(value);
  const mine = (choice += 1);
  if (!file) { uploaded.value = null; iconProblem.value = ''; return; }
  const got = await read(file, iconSizeProblem);
  if (mine !== choice) return;
  const found = 'bytes' in got ? checkIcon(got.bytes) : got;
  iconProblem.value = 'problem' in found ? found.problem : '';
  uploaded.value = 'uri' in found ? found.uri : null;
}
async function chooseHtml(value: File | File[] | null) {
  const file = first(value);
  const mine = (choice += 1);
  if (!file) { html.value = ''; htmlProblem.value = ''; return; }
  const got = await read(file, htmlSizeProblem);
  if (mine !== choice) return;
  const found = 'bytes' in got ? checkHtml(got.bytes) : got;
  htmlProblem.value = 'problem' in found ? found.problem : '';
  html.value = 'html' in found ? found.html : '';
}

// The template as typed. A field is sent as stored while it is unchanged (no trimming of what was already saved), left out
// when empty, and trimmed only when edited. The icon is sent only when chosen: Inherit, and an organization's untouched
// default, leave it to the built-in `auto`.
const ownTemplate = computed(() => (props.own?.mode === 'template' ? props.own : null));
const text = (value: string, stored: string | undefined) => (!value.trim() ? undefined : value === stored ? stored : value.trim());
const template = computed<TemplatePage>(() => {
  const page: TemplatePage = { mode: 'template' };
  if (icon.value === 'auto' || icon.value === 'none') {
    if (icon.value !== 'auto' || iconTouched.value || ownTemplate.value?.icon) page.icon = icon.value;
  } else if (icon.value === 'upload' && uploaded.value) page.icon = uploaded.value;
  const t = text(title.value, ownTemplate.value?.title);
  if (t) page.title = t;
  const d = text(description.value, ownTemplate.value?.description);
  if (d) page.description = d;
  return page;
});
const draft = computed<StoredPage | null>(() => (mode.value === 'custom' ? (html.value ? { mode: 'custom', html: html.value } : null) : template.value));
const bytes = computed(() => new TextEncoder().encode(html.value).length);
const warnings = computed(() => (mode.value === 'custom' && html.value ? htmlWarnings(html.value) : []));
const tooLong = computed(() => [...title.value.trim()].length > TITLE_MAX || [...description.value.trim()].length > DESCRIPTION_MAX);
const canSave = computed(() => !props.saving && !!draft.value && !tooLong.value && !(mode.value === 'template' && icon.value === 'upload' && !uploaded.value));

const preview = computed(() => (draft.value ? previewHtml({ page: resolveDraft(draft.value, props.inherited, props.beneath), favicon: props.favicon, state: state.value, language: language.value, dark: dark.value }) : ''));
const above = computed(() => templateAbove(props.inherited, props.beneath));
const inheritedIcon = computed(() => above.value.icon ?? 'auto');
const inheritText = computed(() => `${inheritedIcon.value === 'none' ? 'none' : inheritedIcon.value === 'auto' ? 'automatic' : 'an uploaded image'}, ${fromLine(props.beneath && props.inherited.mode !== 'template' ? props.beneath.from.icon : props.inherited.from.icon).toLowerCase()}`);
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1040" :fullscreen="smAndDown" scrollable :persistent="saving" @update:model-value="emit('update:modelValue', $event)">
    <v-card data-test="waiting-page-dialog" :title="`Waiting page of ${subject}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiImageOutline" size="20" /></v-avatar></template>
      <v-card-text>
        <div class="dm-wp">
          <div class="dm-wp__form">
            <v-btn-toggle v-if="canCustom" v-model="mode" mandatory divided density="comfortable" color="primary" variant="outlined" class="mb-4" aria-label="Kind of page">
              <v-btn data-test="mode-template" value="template">Template</v-btn>
              <v-btn data-test="mode-custom" value="custom">Custom HTML</v-btn>
            </v-btn-toggle>

            <template v-if="mode === 'template'">
              <p class="text-body-small text-medium-emphasis mb-3">What a visitor reads while the application wakes. The status sentence, in the visitor's language, is always
                Dormeto's. A field left empty comes from the level above.</p>
              <v-alert v-if="inherited.mode === 'custom'" data-test="replaces-custom" type="info" variant="tonal" density="compact" class="mb-3 text-body-small">
                This replaces the custom page set above with Dormeto's template.</v-alert>
              <div class="font-weight-medium mb-1" aria-hidden="true">Icon</div>
              <v-radio-group v-model="icon" hide-details density="compact" aria-label="Icon" @update:model-value="iconTouched = true">
                <v-radio v-if="inheritable" data-test="icon-inherit" value="inherit" :label="`Inherit (${inheritText})`" />
                <v-radio data-test="icon-auto" value="auto" label="Automatic: the application's favicon, read just before a nap (at most once a day)" />
                <v-radio data-test="icon-upload" value="upload" label="Upload an image" />
                <v-radio data-test="icon-none" value="none" label="None" />
              </v-radio-group>
              <div v-if="icon === 'upload'" class="mb-2">
                <v-file-input data-test="icon-file" label="PNG, JPEG, WebP, SVG or ICO, at most 64 KiB" accept="image/*,.ico" density="compact" hide-details="auto" prepend-icon="" :prepend-inner-icon="mdiImageOutline"
                  @update:model-value="chooseIcon" />
                <div v-if="iconProblem" data-test="icon-problem" class="text-error text-body-small mt-1">{{ iconProblem }}</div>
                <img v-else-if="uploaded" :src="uploaded" alt="" class="dm-wp__icon mt-2">
              </div>
              <v-text-field v-model="title" data-test="title" label="Title" persistent-counter :counter="TITLE_MAX" density="compact" class="mt-3" hide-details="auto"
                hint="One line of Markdown: **bold**, *italic*, `code`, [a link](https://example.com)." persistent-hint />
              <v-textarea v-model="description" data-test="description" label="Description" persistent-counter :counter="DESCRIPTION_MAX" rows="3" auto-grow max-rows="8" density="compact" class="mt-3" hide-details="auto"
                hint="Markdown: also headings, lists, quotes and code blocks. Line breaks are kept, raw HTML shows as text." persistent-hint />
            </template>

            <template v-else>
              <p class="text-body-small text-medium-emphasis mb-3">Your own page, as one HTML file (UTF-8, at most 256 KiB; images and fonts inline or at your own addresses). It still wakes the
                workload: Dormeto adds a script at the very start of the document, which looks for these elements and fills them in.</p>
              <v-file-input data-test="html-file" label="HTML file" accept=".html,.htm,text/html" density="compact" hide-details="auto" prepend-icon="" @update:model-value="chooseHtml" />
              <div v-if="htmlProblem" data-test="html-problem" class="text-error text-body-small mt-1">{{ htmlProblem }}</div>
              <div v-else-if="html" class="text-body-small text-medium-emphasis mt-1">{{ bytes.toLocaleString('en-US') }} bytes</div>
              <v-alert v-if="warnings.length" data-test="html-warnings" type="warning" variant="tonal" density="compact" class="mt-3 text-body-small">
                <div v-for="w in warnings" :key="w">{{ w }}</div>
              </v-alert>
              <ul class="dm-wp__hooks text-body-small mt-3">
                <li><code>data-dormeto="status"</code>: its text becomes the status sentence, in the visitor's language.</li>
                <li><code>data-dormeto="elapsed"</code>: its text becomes the seconds with their unit, for example <code>3 s</code>.</li>
                <li><code>data-dormeto="progress"</code>: its width becomes the progress bar's percentage; <code>hidden</code> is removed once a bar applies.</li>
                <li>The <code>dormeto:state</code> event on <code>document</code> fires at each probe, with <code>detail: { state, failure, retryAt, napUntil, elapsedMs, typicalMs }</code>. <code>napUntil.at</code> and <code>napUntil.local</code> are null for a nap with no end known.</li>
              </ul>
              <v-alert type="warning" variant="tonal" density="compact" class="mt-3 text-body-small" data-test="html-security">
                A custom page runs on the application's own address, so its scripts can read that site's cookies and call its API as the visitor. Only administrators can set,
                replace or clear one.
              </v-alert>
            </template>
          </div>

          <div class="dm-wp__preview">
            <div class="font-weight-medium mb-2">Preview</div>
            <v-chip-group v-model="state" mandatory column selected-class="text-primary" class="mb-1" aria-label="State to preview">
              <v-chip v-for="s in PAGE_STATES" :key="s.value" :data-test="`state-${s.value}`" :value="s.value" size="small" variant="outlined" filter>{{ s.title }}</v-chip>
            </v-chip-group>
            <div class="d-flex flex-wrap ga-2 mb-3">
              <v-btn-toggle v-model="language" mandatory density="compact" divided variant="outlined" color="primary" aria-label="Language of the preview">
                <v-btn data-test="language-en" value="en" size="small">English</v-btn>
                <v-btn data-test="language-fr" value="fr" size="small" lang="fr">Français</v-btn>
              </v-btn-toggle>
              <v-btn-toggle :model-value="dark ? 'dark' : 'light'" mandatory density="compact" divided variant="outlined" color="primary" aria-label="Color scheme of the preview" @update:model-value="dark = $event === 'dark'">
                <v-btn data-test="scheme-light" value="light" size="small">Light</v-btn>
                <v-btn data-test="scheme-dark" value="dark" size="small">Dark</v-btn>
              </v-btn-toggle>
            </div>
            <WaitingPagePreview v-if="preview" :html="preview" title="Preview of the waiting page" />
            <div v-else class="dm-wp__empty text-medium-emphasis">Choose an HTML file to preview it.</div>
            <p class="mt-2 mb-0 text-body-small text-medium-emphasis">The preview draws the real page with fixed numbers (a wake 60 % through its usual time). A custom page's
              remote images and fonts do not load in it, and its scripts do not run: the status, seconds and bar fill in on the real page only.</p>
          </div>
        </div>
        <v-alert v-if="shownError" type="error" variant="tonal" density="compact" class="mt-4" data-test="waiting-page-error" :text="shownError" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="saving" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="!canSave" @click="draft && emit('submit', draft)">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-wp { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 24px; align-items: start; }
.dm-wp__form, .dm-wp__preview { min-width: 0; }
.dm-wp__icon { display: block; max-height: 4rem; max-width: 16rem; }
.dm-wp__hooks { padding-left: 1.2rem; }
.dm-wp__hooks li { margin-bottom: 4px; overflow-wrap: anywhere; }
.dm-wp__hooks code { font-family: var(--dm-mono); font-size: 0.85em; }
.dm-wp__empty { display: grid; place-items: center; min-height: 240px; border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 12px; }
@media (max-width: 899px) { .dm-wp { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
</style>
