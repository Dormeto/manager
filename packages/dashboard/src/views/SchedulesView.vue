<script setup lang="ts">
// The Schedules calendar: the windows of the enabled workloads (up to 20) as a day, work week, week or month calendar in the
// browser's zone. FullCalendar draws it; its own header is off and the Vuetify toolbar drives it. Each enabled workload is read
// with GET /workloads/{router}/{id} (4 at a time, on enabling and on refresh, never polled), each with its own state, and its
// occurrences are expanded for the visible range by occurrences.ts.
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useDisplay, useTheme } from 'vuetify';
import { useRoute, useRouter } from 'vue-router';
import FullCalendar from '@fullcalendar/vue3';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { CalendarOptions, DatesSetArg, DateSelectArg, EventClickArg, EventContentArg, EventMountArg } from '@fullcalendar/core';
import { mdiCalendarPlus, mdiChevronLeft, mdiChevronRight, mdiFormatListChecks, mdiRefresh, mdiWeatherNight } from '@mdi/js';
import { api } from '../api';
import { MAX_CALENDARS, calendarKey, eventsFor, freeColor, loadSaved, saveSaved, supportsSchedules, type Calendar, type CalendarStatus, type Enabled, type PanelRow, colorFor } from '../calendars';
import { DAYS, browserZone, type Day, type Schedule } from '../schedule';
import { windowFromSelection } from '../occurrences';
import type { WorkloadStatus, WorkloadSummary } from '../types';
import { useSession } from '../stores/session';
import CalendarsPanel from '../components/CalendarsPanel.vue';
import ScheduleDialog from '../components/ScheduleDialog.vue';
import NewWindowDialog, { type Candidate, type Selection } from '../components/NewWindowDialog.vue';

const session = useSession();
const route = useRoute();
const router = useRouter();
const { smAndDown } = useDisplay();
const theme = useTheme();

// The views, as the address names them and as FullCalendar does.
const VIEWS = { day: 'timeGridDay', work: 'workWeek', week: 'timeGridWeek', month: 'dayGridMonth' } as const;
type ViewName = keyof typeof VIEWS;
const VIEW_LABELS: Record<ViewName, string> = { day: 'Day', work: 'Work week', week: 'Week', month: 'Month' };
const isView = (v: unknown): v is ViewName => typeof v === 'string' && v in VIEWS;
const viewOf = (type: string): ViewName => (Object.keys(VIEWS) as ViewName[]).find((k) => VIEWS[k] === type) ?? 'week';
const userId = () => session.email;

const saved = loadSaved(userId());
const view = ref<ViewName>(isView(route.query.view) ? route.query.view : isView(saved.view) ? saved.view : 'week');
const queryDate = typeof route.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(route.query.date) && !Number.isNaN(Date.parse(route.query.date)) ? route.query.date : undefined;
const initialView = VIEWS[view.value];
const title = ref('');
const range = ref<{ from: number; to: number } | null>(null);
const calendar = ref<InstanceType<typeof FullCalendar> | null>(null);
const fc = () => calendar.value?.getApi();

// The workloads the user may read, and the routers' versions.
const rows = ref<WorkloadSummary[]>([]);
const versions = reactive<Record<string, string | null | undefined>>({});
const listError = ref('');
// The routers that did not answer the list: their workloads are missing from it, not gone.
const routerErrors = ref<{ router: string; message: string }[]>([]);
const listing = ref(false);
const panelRows = computed<PanelRow[]>(() => rows.value.map((w) => ({
  key: calendarKey(w.router, w.workloadId), id: w.workloadId, router: w.router, name: w.name ?? w.workloadId, ...(w.scheduled !== undefined ? { scheduled: w.scheduled } : {}),
  supported: supportsSchedules(versions[w.router]), locked: !canEditRow(w.can),
})));
const canEditRow = (can: { wake: boolean; nap: boolean } | undefined) => (can?.wake ?? session.canOperate) && (can?.nap ?? session.canOperate);

// The enabled calendars, each with its own read.
const enabled = ref<Enabled[]>(saved.enabled);
const enabledColors = computed(() => Object.fromEntries(enabled.value.map((e) => [e.key, e.color])));
interface Read { status: CalendarStatus; data?: WorkloadStatus }
const reads = reactive<Record<string, Read>>({});
const statuses = computed(() => Object.fromEntries(Object.entries(reads).map(([k, r]) => [k, r.status])) as Record<string, CalendarStatus>);
const message = ref('');
const pathOf = (key: string) => { const i = key.indexOf('/'); return `/workloads/${encodeURIComponent(key.slice(0, i))}/${encodeURIComponent(key.slice(i + 1))}`; };

const routerOf = (key: string) => key.slice(0, key.indexOf('/'));
// Only the latest read of a key lands: the calendar may be unticked, or unticked and ticked again, while an earlier read is in flight.
const sequence: Record<string, number> = {};
async function readOne(key: string) {
  const had = reads[key];
  const mine = (sequence[key] = (sequence[key] ?? 0) + 1);
  reads[key] = { status: 'loading', ...(had?.data ? { data: had.data } : {}) };
  const latest = () => sequence[key] === mine && enabled.value.some((e) => e.key === key);
  try {
    const data = await api<WorkloadStatus>(pathOf(key));
    if (!latest()) return;
    // A member's list has no routers block: the workload's own answer tells its router's version.
    if (data.router?.version) versions[routerOf(key)] = data.router.version;
    reads[key] = { status: data.schedule === undefined ? 'unsupported' : 'ok', data };
  } catch {
    if (latest()) reads[key] = { status: 'failed', ...(had?.data ? { data: had.data } : {}) };
  }
}
// A queue of 4 reads at a time; one that fails does not stop the others.
async function readMany(keys: string[]) {
  const queue = [...keys];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) await readOne(key);
  }));
}

function persist(extra: { last?: string } = {}) {
  const now = loadSaved(userId());
  saveSaved(userId(), { enabled: enabled.value, ...(extra.last ?? now.last ? { last: extra.last ?? now.last! } : {}), view: view.value });
}
function toggle(key: string) {
  message.value = '';
  if (enabled.value.some((e) => e.key === key)) {
    enabled.value = enabled.value.filter((e) => e.key !== key);
    delete reads[key];
    persist();
    return;
  }
  if (enabled.value.length >= MAX_CALENDARS) {
    message.value = `At most ${MAX_CALENDARS} calendars at a time: turn one off first.`;
    return;
  }
  enabled.value = [...enabled.value, { key, color: freeColor(enabled.value.map((e) => e.color)) }];
  persist();
  void readOne(key);
}

const PAGE = 1000;
const MAX_PAGES = 50;
const incomplete = ref(false);
async function loadList() {
  listing.value = true;
  try {
    // Pages of 1000 until the total is read (the routers' versions come with each).
    // At most 50 pages, and none that adds no new workload (a server that ignores the offset).
    const all: WorkloadSummary[] = [];
    const seen = new Set<string>();
    const failed = new Map<string, { router: string; message: string }>();
    incomplete.value = false;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { incomplete.value = true; break; }
      const result = await api<{ workloads: WorkloadSummary[]; total?: number; errors?: { router: string; message: string }[]; routers?: { name: string; version?: string | null }[] }>(`/workloads?${new URLSearchParams({ limit: String(PAGE), offset: String(all.length), routers: '1' })}`);
      const fresh = result.workloads.filter((w) => !seen.has(calendarKey(w.router, w.workloadId)));
      for (const w of fresh) seen.add(calendarKey(w.router, w.workloadId));
      all.push(...fresh);
      for (const r of result.routers ?? []) versions[r.name] = r.version;
      for (const e of result.errors ?? []) failed.set(e.router, e);
      if (!fresh.length) { incomplete.value = all.length < (result.total ?? 0); break; }
      if (all.length >= (result.total ?? all.length)) break;
    }
    rows.value = all;
    routerErrors.value = [...failed.values()];
    listError.value = '';
  } catch (err) {
    listError.value = (err as Error).message;
  } finally {
    listing.value = false;
  }
}
async function refresh() {
  await loadList();
  await readMany(enabled.value.map((e) => e.key));
}
onMounted(async () => {
  await loadList();
  // A calendar whose workload is gone from the list is dropped; the list failing, or its router not answering, leaves the saved ones as they are.
  if (!listError.value) {
    const known = new Set(rows.value.map((w) => calendarKey(w.router, w.workloadId)));
    const silent = new Set(routerErrors.value.map((e) => e.router));
    enabled.value = enabled.value.filter((e) => known.has(e.key) || silent.has(routerOf(e.key)));
  }
  await readMany(enabled.value.map((e) => e.key));
});

// What is drawn.
const nameOf = (key: string) => reads[key]?.data?.name ?? rows.value.find((w) => calendarKey(w.router, w.workloadId) === key)?.name ?? key.slice(key.indexOf('/') + 1);
const calendars = computed<Calendar[]>(() => enabled.value.flatMap((e) => {
  const data = reads[e.key]?.data;
  if (!data) return [];
  return [{ key: e.key, name: nameOf(e.key), color: colorFor(e.color), schedule: data.schedule ?? null, state: data.state, maintenanceDue: data.maintenanceDue ?? null, next: data.next }];
}));
const events = computed(() => (range.value ? eventsFor(calendars.value, range.value.from, range.value.to, undefined, theme.global.current.value.dark, Date.now()) : []));

const dateText = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function datesSet(arg: DatesSetArg) {
  title.value = arg.view.title;
  range.value = { from: arg.start.getTime(), to: arg.end.getTime() };
  view.value = viewOf(arg.view.type);
  const query = { ...route.query, view: view.value, date: dateText(arg.view.calendar.getDate()) };
  if (route.query.view !== query.view || route.query.date !== query.date) void router.replace({ query });
  persist();
}
const go = (action: 'prev' | 'next' | 'today') => fc()?.[action]();
const show = (v: ViewName) => fc()?.changeView(VIEWS[v]);

// An event opens its workload's schedule (the workload's page for one the user may not edit).
const dialogKey = ref<string | null>(null);
const dialogOpen = ref(false);
const dialogError = ref('');
const saving = ref(false);
const canEdit = (key: string) => {
  const can = reads[key]?.data?.can ?? rows.value.find((w) => calendarKey(w.router, w.workloadId) === key)?.can;
  return canEditRow(can);
};
function eventClick(arg: EventClickArg) {
  const key = arg.event.extendedProps.key as string;
  if (!canEdit(key)) {
    const i = key.indexOf('/');
    void router.push({ name: 'workload', params: { router: key.slice(0, i), id: key.slice(i + 1) } });
    return;
  }
  dialogKey.value = key;
  dialogError.value = '';
  dialogOpen.value = true;
}
async function saveSchedule(schedule: Schedule) {
  const key = dialogKey.value;
  if (!key) return;
  saving.value = true;
  dialogError.value = '';
  try {
    await api(`${pathOf(key)}/schedule`, { method: 'PUT', body: JSON.stringify(schedule) });
    dialogOpen.value = false;
    persist({ last: key });
    await readOne(key);
  } catch (err) {
    dialogError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function clearSchedule() {
  const key = dialogKey.value;
  if (!key) return;
  saving.value = true;
  dialogError.value = '';
  try {
    await api(`${pathOf(key)}/schedule`, { method: 'DELETE' });
    dialogOpen.value = false;
    await readOne(key);
  } catch (err) {
    dialogError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

// A new window: a selection of the calendar, or the New window button, opens the dialog for the workloads the user may edit.
const newOpen = ref(false);
const newSelection = ref<Selection | null>(null);
const newError = ref('');
const newSaving = ref(false);
const notice = ref('');
const last = ref(saved.last);
const editable = computed<Candidate[]>(() => enabled.value.flatMap((e) => {
  const r = reads[e.key];
  const can = r?.data?.can;
  if (r?.status !== 'ok' || !r.data || !(can?.wake && can.nap)) return [];
  return [{ key: e.key, name: nameOf(e.key), schedule: r.data.schedule ?? null }];
}));
function openNew(selection: Selection) {
  notice.value = '';
  newError.value = '';
  newSelection.value = selection;
  newOpen.value = true;
}
const WEEKDAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function select(arg: DateSelectArg) {
  if (arg.view.type === 'dayGridMonth') {
    const days = new Set<Day>();
    for (const d = new Date(arg.start); d < arg.end && days.size < 7; d.setDate(d.getDate() + 1)) days.add(WEEKDAYS[d.getDay()]!);
    openNew({ start: arg.start, end: arg.end, month: true, days: DAYS.filter((d) => days.has(d)) });
    return;
  }
  // The browser's clock decides here (a day of 25 hours is 24 on the clock); the dialog checks the workload's zone.
  const placed = windowFromSelection(arg.start, arg.end, browserZone());
  if ('problem' in placed) {
    notice.value = placed.problem;
    fc()?.unselect();
    return;
  }
  openNew({ start: arg.start, end: arg.end, month: false });
}
function newWindowButton() {
  const start = new Date();
  start.setHours(start.getHours() + 1, 0, 0, 0);
  openNew({ start, end: new Date(start.getTime() + 3_600_000), month: false });
}
async function saveNew(arg: { key: string; schedule: Schedule }) {
  newSaving.value = true;
  newError.value = '';
  try {
    await api(`${pathOf(arg.key)}/schedule`, { method: 'PUT', body: JSON.stringify(arg.schedule) });
    newOpen.value = false;
    last.value = arg.key;
    persist({ last: arg.key });
    await readOne(arg.key);
  } catch (err) {
    newError.value = (err as Error).message;
  } finally {
    newSaving.value = false;
  }
}
watch(newOpen, (open) => { if (!open) fc()?.unselect(); });

function eventDidMount(arg: EventMountArg) {
  arg.el.title = String(arg.event.extendedProps.tip ?? arg.event.title);
}

const options = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
  initialView, ...(queryDate ? { initialDate: queryDate } : {}),
  headerToolbar: false, timeZone: 'local', firstDay: 1, nowIndicator: true, allDaySlot: false, selectable: true, selectMirror: true, select,
  slotDuration: '00:30:00', snapDuration: '00:15:00', // 15-minute steps in the time grids
  scrollTime: '07:00:00', slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
  eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false }, eventMaxStack: 3, height: smAndDown.value ? 'auto' : 'calc(100vh - 250px)',
  views: {
    workWeek: { type: 'timeGrid', duration: { weeks: 1 }, weekends: false },
    dayGridMonth: { eventDisplay: 'list-item', dayMaxEvents: true }, // a dot, the start time and the title on the start day: no bars across days
  },
  events: events.value, datesSet, eventClick, eventDidMount,
}));

const drawer = ref(false);
watch(smAndDown, (small) => { if (!small) drawer.value = false; });
const dialogSchedule = computed(() => (dialogKey.value ? reads[dialogKey.value]?.data?.schedule ?? null : null));
const eventLabel = (arg: EventContentArg) => arg.event.title;
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-4">
    <div>
      <div class="dm-eyebrow mb-1">Fleet</div>
      <h1 class="text-headline-small">Schedules</h1>
    </div>
  </div>
  <v-alert v-if="listError" type="error" class="mb-4" :text="listError" />
  <v-alert v-for="e in routerErrors" :key="e.router" data-test="router-error" type="warning" variant="tonal" density="compact" class="mb-4" :title="`Router ${e.router} unreachable`" :text="`${e.message} Its workloads are missing from the panel; the calendars you enabled stay.`" />
  <v-alert v-if="incomplete" data-test="list-incomplete" type="warning" variant="tonal" density="compact" class="mb-4" text="The list of workloads is incomplete: some may be missing from the panel." />
  <v-alert v-if="smAndDown" data-test="touch-hint" type="info" variant="tonal" density="compact" class="mb-4" text="Touch and hold, then drag, to create a window — or use New window." />
  <v-alert v-if="notice" data-test="select-notice" type="warning" variant="tonal" closable class="mb-4" :text="notice" @click:close="notice = ''" />
  <div class="dm-sched">
    <v-card v-if="!smAndDown" class="dm-sched__panel pa-4">
      <CalendarsPanel :rows="panelRows" :enabled="enabledColors" :status="statuses" :message="message" :loading="listing" @toggle="toggle" />
    </v-card>
    <v-navigation-drawer v-else v-model="drawer" temporary location="end" width="320">
      <div class="pa-4"><CalendarsPanel :rows="panelRows" :enabled="enabledColors" :status="statuses" :message="message" :loading="listing" @toggle="toggle" /></div>
    </v-navigation-drawer>
    <v-card class="dm-sched__main">
      <div class="dm-sched__bar">
        <v-btn data-test="today" variant="outlined" size="small" @click="go('today')">Today</v-btn>
        <v-btn data-test="prev" :icon="mdiChevronLeft" variant="text" size="small" aria-label="Previous" @click="go('prev')" />
        <v-btn data-test="next" :icon="mdiChevronRight" variant="text" size="small" aria-label="Next" @click="go('next')" />
        <h2 data-test="title" class="dm-sched__title" aria-live="polite">{{ title }}</h2>
        <v-spacer />
        <v-btn v-if="smAndDown" data-test="panel-toggle" :prepend-icon="mdiFormatListChecks" variant="tonal" size="small" @click="drawer = !drawer">Calendars</v-btn>
        <v-btn data-test="new-window" :prepend-icon="mdiCalendarPlus" variant="tonal" size="small" color="primary" title="Or drag over the calendar" @click="newWindowButton">New window</v-btn>
        <v-btn data-test="refresh" :icon="mdiRefresh" variant="text" size="small" aria-label="Refresh" :loading="listing" @click="refresh" />
        <v-btn-toggle :model-value="view" mandatory density="compact" variant="outlined" divided class="dm-sched__views" @update:model-value="show($event)">
          <v-btn v-for="(label, v) in VIEW_LABELS" :key="v" :data-test="`view-${v}`" :value="v" size="small">{{ label }}</v-btn>
        </v-btn-toggle>
      </div>
      <div class="dm-sched__calendar">
        <FullCalendar ref="calendar" :options="options">
          <template #eventContent="arg">
            <div class="dm-ev__body" :class="{ 'dm-ev__body--grid': arg.view.type === 'dayGridMonth' }">
              <v-icon v-if="arg.event.extendedProps.kind === 'nap'" data-test="moon" :icon="mdiWeatherNight" size="12" class="dm-ev__moon" />
              <span v-if="arg.timeText" class="fc-event-time">{{ arg.timeText }}</span>
              <span class="fc-event-title">{{ eventLabel(arg) }}</span>
            </div>
          </template>
        </FullCalendar>
      </div>
    </v-card>
  </div>
  <NewWindowDialog v-model="newOpen" :candidates="editable" :selection="newSelection" :last="last" :error="newError" :saving="newSaving" @submit="saveNew" />
  <ScheduleDialog v-model="dialogOpen" :schedule="dialogSchedule" :name="dialogKey ? nameOf(dialogKey) : ''" :error="dialogError" :saving="saving" @submit="saveSchedule" @clear="clearSchedule" />
</template>

<style scoped>
.dm-sched { display: flex; gap: 16px; align-items: flex-start; }
.dm-sched__panel { flex: 0 0 280px; max-height: calc(100vh - 160px); overflow-y: auto; }
.dm-sched__main { flex: 1 1 auto; min-width: 0; }
.dm-sched__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 12px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-sched__title { font-size: 1.05rem; font-weight: 600; margin-left: 8px; }
.dm-sched__views { flex: none; }
.dm-sched__calendar { padding: 8px 12px 12px; }

/* FullCalendar in the Vuetify theme. */
.dm-sched__calendar :deep(.fc) {
  --fc-border-color: rgba(var(--v-border-color), var(--v-border-opacity));
  --fc-page-bg-color: rgb(var(--v-theme-surface));
  --fc-neutral-bg-color: rgb(var(--v-theme-surface));
  --fc-today-bg-color: rgba(var(--v-theme-primary), 0.07);
  --fc-more-link-bg-color: rgba(var(--v-theme-on-surface), 0.16);
  --fc-now-indicator-color: rgb(var(--v-theme-error));
  --fc-event-border-color: transparent;
  font-size: 0.82rem;
}
.dm-sched__calendar :deep(.fc a) { color: inherit; text-decoration: none; }
.dm-sched__calendar :deep(.fc-col-header-cell-cushion), .dm-sched__calendar :deep(.fc-daygrid-day-number) { padding: 4px 6px; }
.dm-sched__calendar :deep(.fc-event) { cursor: pointer; border-width: 2px; border-radius: 6px; }
.dm-sched__calendar :deep(.fc-event.dm-ev--nap) { border-style: solid; background: transparent; }
.dm-sched__calendar :deep(.fc-event.dm-ev--maintenance) { border-style: dashed; }
.dm-sched__calendar :deep(.fc-event.dm-past) { opacity: 0.45; }
/* FullCalendar's icon font is a data: URI the content security policy (font-src 'self') refuses: no icon uses it, text glyphs instead. */
.dm-sched__calendar :deep(.fc-icon) { font-family: inherit !important; }
.dm-sched__calendar :deep(.fc-icon-x::before) { content: '\00d7'; }
.dm-sched__calendar :deep(.fc-icon-chevron-left::before) { content: '\2039'; }
.dm-sched__calendar :deep(.fc-icon-chevron-right::before) { content: '\203a'; }
.dm-sched__calendar :deep(.fc-icon-chevrons-left::before) { content: '\00ab'; }
.dm-sched__calendar :deep(.fc-icon-chevrons-right::before) { content: '\00bb'; }
.dm-sched__calendar :deep(.fc-icon-minus-square::before) { content: '\2212'; }
.dm-sched__calendar :deep(.fc-icon-plus-square::before) { content: '+'; }
.dm-sched__calendar :deep(.fc-event:focus-visible) { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 1px; }
.dm-ev__body { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; padding: 1px 4px; overflow: hidden; line-height: 1.25; }
.dm-ev__body--grid { flex-wrap: nowrap; align-items: baseline; padding: 0 4px; }
.dm-ev__body > span:not(.dm-ev__moon) { max-width: 100%; min-width: 0; overflow: hidden; overflow-wrap: normal; word-break: normal; white-space: nowrap; text-overflow: ellipsis; }
.dm-ev__body--grid .fc-event-time { flex: none; }
.dm-sched__calendar :deep(.fc-daygrid-dot-event) { border-width: 0; border-radius: 4px; }
.dm-sched__calendar :deep(.fc-daygrid-dot-event .fc-event-main) { min-width: 0; overflow: hidden; }
.dm-sched__calendar :deep(.fc-popover) { background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); overflow: hidden; }
.dm-sched__calendar :deep(.fc-popover-header) { background: rgba(var(--v-theme-on-surface), 0.06); }
.dm-ev__moon { align-self: center; }
.dm-ev__body .fc-event-time { font-weight: 600; }

@media (max-width: 960px) {
  .dm-sched__bar { padding: 10px 12px; }
  .dm-sched__calendar { padding: 4px 4px 8px; }
}
</style>
