<script setup lang="ts">
// Organization discovery: the last run (scanned, skipped and failed account-regions, lint) and the candidates, a status
// at a time, paged on the server by its cursor (scale design §5), starting with the statuses people act on. The candidates'
// table (tables design §4, §5): a selection that outlives a page turned, each row's menu, the exports of every candidate
// of the status and filters shown.
import { computed, onBeforeUnmount, onMounted, ref, watch as watchValue } from 'vue';
import { mdiAlertCircleOutline, mdiAlertOutline, mdiCancel, mdiCheckCircleOutline, mdiChevronLeft, mdiChevronRight, mdiCogOutline, mdiEarth, mdiEyeOffOutline, mdiEyeOutline, mdiLanConnect, mdiLogoutVariant,
  mdiOfficeBuildingOutline, mdiPlay, mdiPlusCircleOutline, mdiServerOutline, mdiProgressClock, mdiSkipNextCircleOutline, mdiTarget, mdiTimerOffOutline, mdiTimerOutline } from '@mdi/js';
import type { AnyCandidate, ResourceKind, RunRecord, Status } from '@dormeto/discovery/types';
import { useRoute } from 'vue-router';
import KindMark from '../components/KindMark.vue';
import { isStandalone, kindInfo, type Kind } from '../kinds';
import { cloudOf, isCandidateRegion } from '@dormeto/fleet/clouds';
import { api } from '../api';
import CloudMark from '../components/CloudMark.vue';
import ExcludeDialog from '../components/ExcludeDialog.vue';
import OnboardDialog from '../components/OnboardDialog.vue';
import type { ClusterCheck, RouterInfo } from '../types';
import type { KubernetesCandidate } from '../kubernetes';
import LintAlert from '../components/LintAlert.vue';
import OrganizationAccess from '../components/OrganizationAccess.vue';
import { onboardRefusal, type AccessReport } from '../access';
import { exclusionTargets, exclusionText } from '../pause';
import type { Exclusion } from '../types';
import type { Notice } from '../components/NoticeAlert.vue';
import NoticeToast from '../components/NoticeToast.vue';
import { operationLabel, operationWatch } from '../operation-watch';
import { cursorPages, readCursor, visibleStatuses, firstStatus, idleShare, latestOnly, ruleLines, statusColor, statusLabel, targetText, type CursorRead } from '../discovery';
import { backendLabel, cloudMark, relative, rowCloud, shortId } from '../format';
import { cloudWords } from '../cloud-words';
import { googleRouterTooOld, lbText, urlMapConsoleUrl } from '../google';
import { useCountUp } from '../count-up';
import { EXPORT_LIMIT, type DmAction, type DmExport, type DmHeader, type DmRead, type DmServer } from '../table';
import BackendKinds from '../components/BackendKinds.vue';
import BackendLabel from '../components/BackendLabel.vue';
import DiscoveryStatusChip from '../components/DiscoveryStatusChip.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import DmTable from '../components/DmTable.vue';
import KindSelect from '../components/KindSelect.vue';
import RunProblems from '../components/RunProblems.vue';
import IdleBar from '../components/IdleBar.vue';
import RegionLabel from '../components/RegionLabel.vue';
import StatusHelp from '../components/StatusHelp.vue';
import StatusMark from '../components/StatusMark.vue';
import { useNow } from '../now';
import { useDiscoveryBadge } from '../stores/discovery';
import { useSession } from '../stores/session';
import InfoTip from '../components/InfoTip.vue';
import PageTitle from '../components/PageTitle.vue';

const now = useNow();
const session = useSession();
const badge = useDiscoveryBadge();
// A managed candidate carries its workload's name and router (from its summary), and the onboarding or offboarding
// running on it.
type Listed = AnyCandidate & { workload?: { router: string; workloadId: string; name: string }; operation?: { id: string; type: 'onboard' | 'offboard' } };
const PAGE = 50;
// An export and a search read the API's largest pages (scale design §5), one at a time.
const EXPORT_PAGE = 200;
const lastRun = ref<RunRecord | null>(null);
// Organization access of the last run (packaging design §3), and the roles set in the manager's Terraform.
const access = ref<AccessReport | null>(null);
const roles = ref<{ discoveryRole: string; commandRole: string } | null>(null);
const counts = ref<Partial<Record<Status, number>>>({});
const candidates = ref<Listed[]>([]);
const loading = ref(false);
const running = ref(false);
const error = ref('');
const status = ref<Status | null>(null);
const account = ref('');
const region = ref('');
// The filters the list shows: those typed, once typing pauses (an export and its PDF read these, not a filter half typed).
const applied = ref({ account: '', region: '' });
const page = ref(0);
const pages = cursorPages();
const hasNext = ref(false);
// Answers of earlier page requests (a filter typed on, a page turned meanwhile) are dropped.
const latest = latestOnly();
// A Run now refused since the last run (another run was in progress).
const refused = ref<RunRecord | null>(null);
// Search (tables design §5): the API has no text search, so a search reads every candidate of the status within the
// filters (by the cursor, 5,000 at most, said when cut); the table filters them on what its columns say and pages them.
// Cleared, the cursor's pages again.
const search = ref('');
const searched = ref('');
const searchMode = computed(() => searched.value !== '');
const everything = ref<Listed[]>([]);
const everythingCut = ref<string | null>(null);
const reading = ref(false);
// The rows the table holds: the search's whole list, or the cursor's page.
const listed = computed(() => (searchMode.value ? everything.value : candidates.value));
// The candidates chosen, by id, on any page or list seen (tables design §5); each as it was last read, for the selection's
// actions.
const selected = ref<string[]>([]);
const picked = ref<Record<string, Listed>>({});
const chosen = computed(() => selected.value.map((id) => listed.value.find((c) => c.id === id) ?? picked.value[id]).filter((c): c is Listed => Boolean(c)));
// The rows chosen in the list about to be replaced, kept as they were read.
function keepChosen() {
  for (const c of chosen.value) picked.value[c.id] = c;
}
const dismissDialog = ref(false);
const note = ref('');
const exclusions = ref<Exclusion[]>([]);
const onboardOpen = ref(false);
// A row's action acts on its candidate alone, the selection left as it is: `target`, set as its dialog opens (the selection's
// buttons set none) and kept while it closes, so that the dialog shows the same until it is gone. The dialogs and their
// messages read `acting`: the row's candidate, else the one selected.
const target = ref<Listed | null>(null);
const acting = computed(() => target.value ?? single.value);
// A Kubernetes candidate (R10.5): its owner and switch for the dialog, and its router's last check of its cluster.
const actingKubernetes = computed(() => {
  const backend = acting.value?.backend as { kind?: string; kubernetes?: KubernetesCandidate } | null | undefined;
  return backend?.kind === 'k8s' ? backend.kubernetes ?? null : null;
});
const backendKind = (c: Listed) => c.backend?.kind;
const clusterAccess = ref<ClusterCheck | null>(null);
// A Google Cloud candidate's routers of 0.40.0 and later (an older one can't be acted through): its region's, or for a
// `global` one every router of the project, the dialog asking which; null while a `global` one's are read (the dialog waits).
const projectRouters = ref<{ name: string; region: string }[] | null>([]);
// The API needs a `global` candidate's router named when its project has several, whatever their versions.
const chooseRouter = ref(false);
watchValue(onboardOpen, async (open) => {
  clusterAccess.value = null;
  projectRouters.value = [];
  chooseRouter.value = false;
  const c = acting.value;
  const kubernetes = actingKubernetes.value;
  if (!open || !c || (!kubernetes && !isGoogle(c))) return;
  if (!kubernetes && c.region === 'global') projectRouters.value = null;
  const routers = (await api<{ routers: RouterInfo[] }>('/routers').catch(() => ({ routers: [] as RouterInfo[] }))).routers;
  if (!kubernetes) {
    const ofProject = routers.filter((r) => r.cloud === 'gcp' && r.account === c.account);
    chooseRouter.value = c.region === 'global' && ofProject.length > 1;
    projectRouters.value = ofProject.filter((r) => (c.region === 'global' || r.region === c.region) && !googleRouterTooOld(r)).map((r) => ({ name: r.name, region: r.region }));
    return;
  }
  clusterAccess.value = routers.find((r) => r.account === c.account && r.region === c.region)?.clusters?.find((x) => x.name === kubernetes.cluster) ?? null;
});
const excludeOpen = ref(false);
// A dialog opened for a row's candidate, or for the selection (null).
const dialogs = { onboard: onboardOpen, exclude: excludeOpen, dismiss: dismissDialog };
function openFor(c: Listed | null, dialog: keyof typeof dialogs) {
  target.value = c;
  dialogs[dialog].value = true;
}
const notice = ref<Notice | null>(null);
let poll: number | undefined;
// Onboardings and offboardings running on the candidates shown: the page is refreshed every 10 s while one runs, and a
// toast says how each one ended (the candidate then moves to its status).
// An operation that ended: the list read again, the rows ticked staying ticked but those that left it.
const watch = operationWatch((n) => {
  notice.value = n;
  void load({ selection: 'refresh' });
});
// Quiet (no loader: the rows are swapped when read), never two at once (a tick while one reads is skipped), and under a search
// one tick in three: its whole list is read again (26 requests at most, where the cursor's page is one), and the toast of an
// operation that ended comes 30 s after at most.
let following: number | undefined;
let refreshing = false;
let ticks = 0;
function follow() {
  if (following !== undefined || !watch.active) return;
  ticks = 0;
  following = window.setInterval(() => {
    if (!watch.active) {
      window.clearInterval(following);
      following = undefined;
      return;
    }
    ticks += 1;
    if (refreshing || (searchMode.value && ticks % 3 !== 0)) return;
    refreshing = true;
    reloadList('refresh', true).catch((err: Error) => { error.value = err.message; }).finally(() => { refreshing = false; });
  }, 10_000);
}
// A Google Cloud candidate is a backend service named in a URL map (its id is the service's path); its console pages are the map's.
const isGoogle = (c: Listed) => rowCloud(c) === 'gcp';
// The ~ of an estimated idle share (Google Cloud's: the user, 2026-11-12).
const idleMark = (c: Listed) => cloudWords(rowCloud(c)).idleMark;
// A standalone candidate's resource kind (its idle share is by its signals).
const resourceOf = (c: Listed): ResourceKind | undefined => (c.kind === 'standalone' ? c.backend.kind : undefined);
// A standalone candidate is its resource (design §6): its name, and its kind and id as the router names them.
const resourceText = (c: Listed) => (c.kind === 'standalone' ? `${backendLabel(c.backend.kind, 'aws')} ${c.backend.kind === 'ecs' ? (c.backend.arn ?? c.backend.id).split(':service/')[1] ?? c.backend.id : c.backend.id}` : '');
// One kind of candidates (the API's filter), from the address too.
const route = useRoute();
const kindFilter = ref<Kind | null>(route.query.kind === 'http' || route.query.kind === 'standalone' ? route.query.kind : null);
function filterByKind(kind: Kind | null) {
  kindFilter.value = kind;
  restart();
}
const mapLink = (c: Listed) => (c.urlMap ? urlMapConsoleUrl(c.urlMap, c.lb, c.account) : null);
const subjectOf = (c: Listed) => c.workload?.name ?? (c.kind === 'standalone' ? c.name : c.targetGroup) ?? c.id;
// The filter takes an AWS account or a Google Cloud project; the region within it is that cloud's.
const accountCloud = computed(() => cloudOf(account.value));
const filtered = computed(() => accountCloud.value !== null);
// The region typed within a project is Google Cloud's (or `global`), within an account AWS's.
const regionHint = computed(() => cloudWords(accountCloud.value).regionHint);

// The list asked: the shown status, within the account (and region) applied, `limit` a page.
const appliedCloud = computed(() => cloudOf(applied.value.account));
const regionSent = computed(() => Boolean(appliedCloud.value && isCandidateRegion(appliedCloud.value, applied.value.region)));
function listQuery(limit: number): URLSearchParams | null {
  if (!status.value) return null;
  const query = new URLSearchParams({ status: status.value, limit: String(limit), ...(kindFilter.value ? { kind: kindFilter.value } : {}) });
  if (appliedCloud.value) {
    query.set('account', applied.value.account);
    if (regionSent.value) query.set('region', applied.value.region);
  }
  return query;
}

// What a list's answer does to the selection: another list starts it again ('clear'), a page turned or a search keeps it
// ('keep'), a refresh of the list drops the rows that left it ('refresh').
type Selection = 'clear' | 'keep' | 'refresh';
function select(selection: Selection, before: Listed[], after: Listed[]) {
  if (selection === 'clear') {
    selected.value = [];
    picked.value = {};
  } else if (selection === 'refresh') {
    const left = new Set(before.filter((c) => !after.some((x) => x.id === c.id)).map((c) => c.id));
    selected.value = selected.value.filter((id) => !left.has(id));
  }
  watch.refreshed(after.flatMap((c) => (c.operation ? [{ ...c.operation, subject: subjectOf(c) }] : [])));
  follow();
}
// One page of the shown status, within the account (and region) when given.
async function loadPage({ selection = 'clear' }: { selection?: Selection } = {}) {
  const query = listQuery(PAGE);
  if (!query) return;
  const at = page.value;
  const cursor = pages.cursor(at);
  if (cursor) query.set('cursor', cursor);
  const answer = await latest(() => api<{ candidates: Listed[]; cursor: string | null }>(`/discovery/candidates?${query}`));
  if (!answer) return;
  pages.loaded(at, answer.value.cursor);
  hasNext.value = pages.hasNext(at);
  const before = candidates.value;
  keepChosen();
  candidates.value = answer.value.candidates;
  select(selection, before, candidates.value);
}

// Every candidate of the shown status within the filters applied (an export, a search), the cursor followed one page at a
// time, bounded (readCursor): `limit` at most.
function readCandidates(limit: number, signal?: AbortSignal): Promise<CursorRead<Listed>> | null {
  const query = listQuery(EXPORT_PAGE);
  if (!query) return null;
  return readCursor<Listed>(async (cursor) => {
    const asked = new URLSearchParams(query);
    if (cursor) asked.set('cursor', cursor);
    const answer = await api<{ candidates: Listed[]; cursor: string | null }>(`/discovery/candidates?${asked}`);
    return { rows: answer.candidates, cursor: answer.cursor };
  }, limit, EXPORT_PAGE, signal);
}
const many = (n: number, what: string) => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

// An export (tables design §5): the API does not count a filtered list, nor what a scoped user sees: the table asks one
// row more than it keeps to know there are others. A reading stopped by its bounds says so at the file's end.
async function readAll(limit: number): Promise<Listed[] | DmRead<Listed>> {
  const read = await readCandidates(limit);
  if (!read) return [];
  if (read.end === 'cursor') return { rows: read.rows, note: `${many(read.rows.length, 'row')} read, then the API gave the same page twice: the reading stopped there.` };
  if (read.end === 'requests') return { rows: read.rows, note: `${many(read.rows.length, 'row')} read in ${read.requests} requests, the most an export makes: narrow the search or the filters to export the others.` };
  return read.rows;
}
const server = computed<DmServer<Listed>>(() => ({ total: null, all: readAll }));

// A search's list: every candidate, 5,000 at most (one more read to know there are others), what cut it said above the
// table and at the end of its export. A reading replaced by another, or by the search cleared or the view left, stops before
// its next page and its answer is dropped. `quiet` (a refresh): no loader, the rows swapped when read.
let searchRead: AbortController | null = null;
function stopSearch() {
  searchRead?.abort();
  searchRead = null;
  reading.value = false;
}
async function loadSearch(selection: Selection = 'keep', quiet = false) {
  searchRead?.abort();
  const mine = new AbortController();
  searchRead = mine;
  reading.value = !quiet;
  try {
    const answer = await latest(() => readCandidates(EXPORT_LIMIT + 1, mine.signal) ?? Promise.resolve(null));
    if (!answer?.value || mine.signal.aborted) return;
    const read = answer.value;
    const before = everything.value;
    keepChosen();
    everything.value = read.rows.slice(0, EXPORT_LIMIT);
    everythingCut.value = read.rows.length > EXPORT_LIMIT
      ? `Searched among the first ${many(EXPORT_LIMIT, 'candidate')} of this status: narrow the filters to search the others.`
      : read.end === 'cursor' ? `Searched among the ${many(read.rows.length, 'candidate')} read, then the API gave the same page twice: the reading stopped there.`
        : read.end === 'requests' ? `Searched among the ${many(read.rows.length, 'candidate')} read in ${read.requests} requests, the most a search makes: narrow the filters to search the others.`
          : null;
    select(selection, before, everything.value);
  } finally {
    if (searchRead === mine) {
      searchRead = null;
      reading.value = false;
    }
  }
}
// The list shown read again: the search's, or the cursor's page (a page read shows no loader of its own).
function reloadList(selection: Selection, quiet = false) {
  return searchMode.value ? loadSearch(selection, quiet) : loadPage({ selection });
}
// A search typed: applied once typing pauses; the whole list read when one starts, the cursor's page again when it ends.
let searchTyping: number | undefined;
watchValue(search, (text) => {
  window.clearTimeout(searchTyping);
  searchTyping = window.setTimeout(() => {
    const next = (text ?? '').trim();
    if (Boolean(next) === searchMode.value) {
      searched.value = next;
      return;
    }
    keepChosen();
    searched.value = next;
    // Cleared: the search's reading stops, the cursor's page at once.
    if (next) everything.value = [];
    else stopSearch();
    reloadList('keep').catch((err: Error) => { error.value = err.message; });
  }, 400);
});

type DiscoveryAnswer = { lastRun: RunRecord | null; refused?: RunRecord; counts: Partial<Record<Status, number>>; access?: { discoveryRole: string; commandRole: string } };
// The last run, a refused one and the counts, from GET /discovery.
function readRun(result: DiscoveryAnswer) {
  roles.value = result.access ?? null;
  lastRun.value = result.lastRun;
  refused.value = result.refused ?? null;
  counts.value = result.counts;
  badge.fromCounts(result.counts);
}
// Everything read again; `quiet`: no loader (the run's end, read while the page is looked at).
async function load({ selection = 'clear', quiet = false }: { selection?: Selection; quiet?: boolean } = {}) {
  if (!quiet) loading.value = true;
  try {
    const [result, excluded, report] = await Promise.all([
      api<DiscoveryAnswer>('/discovery'),
      api<{ exclusions: Exclusion[] }>('/exclusions'),
      api<AccessReport>('/discovery/access?limit=1000').catch(() => null),
    ]);
    access.value = report;
    readRun(result);
    exclusions.value = excluded.exclusions.sort((a, b) => b.at.localeCompare(a.at));
    status.value ??= firstStatus(result.counts);
    await reloadList(selection, quiet);
    error.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    if (!quiet) loading.value = false;
  }
}

// Another status or filter starts again from the first page.
function show(next: Status | null) {
  if (!next) return;
  status.value = next;
  restart();
}
function restart() {
  applied.value = { account: account.value, region: region.value };
  page.value = 0;
  pages.reset();
  load();
}
// A filter being typed: loaded once typing pauses.
let typing: number | undefined;
function restartSoon() {
  window.clearTimeout(typing);
  typing = window.setTimeout(restart, 400);
}
// Another page of the same list: the selection stays. A click while a page loads is ignored (the buttons stay enabled, so
// the keyboard's focus stays on them).
function turn(by: number) {
  if (loading.value) return;
  page.value += by;
  load({ selection: 'keep' });
}

// The run is asynchronous: poll until a new run record appears (a run takes seconds to minutes).
async function runNow() {
  running.value = true;
  const before = lastRun.value?.startedAt;
  try {
    await api('/discovery/run', { method: 'POST' });
  } catch (err) {
    error.value = (err as Error).message;
    running.value = false;
    return;
  }
  const refusedBefore = refused.value?.startedAt;
  // Until a new run finished (it shows as running while its accounts are scanned), or this one was refused; a run lasts
  // 3 hours at most. Meanwhile the run's state alone, every 5 s (a tick while one is read skipped); at its end the rest once,
  // quietly, the rows ticked staying ticked.
  const deadline = Date.now() + 3 * 3_600_000;
  let asking = false;
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    if (asking) return;
    asking = true;
    try {
      readRun(await api<DiscoveryAnswer>('/discovery'));
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      asking = false;
    }
    const finished = lastRun.value?.startedAt !== before && lastRun.value?.status !== 'running';
    if (finished || refused.value?.startedAt !== refusedBefore || Date.now() > deadline) {
      window.clearInterval(poll);
      running.value = false;
      void load({ selection: 'refresh', quiet: true });
    }
  }, 5000);
}

// After an action, the list read again: the selection's leaves nothing ticked; a row's leaves the selection as it was, but
// the rows that left the list.
const afterAction = (row: boolean): Selection => (row ? 'refresh' : 'clear');

// The API takes 100 ids a request: a selection beyond (it spans pages and searches) is sent by batches, one after the other.
// A batch refused: those done are said, the others stay ticked.
const BATCH = 100;
async function changeDismissal(action: 'dismiss' | 'restore', ids = selected.value, row = false) {
  const done: string[] = [];
  const word = action === 'dismiss' ? 'dismissed' : 'restored';
  let changed = 0;
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const answer = await api<{ candidates?: unknown[] }>(`/discovery/${action}`, { method: 'POST', body: JSON.stringify({ ids: batch, ...(action === 'dismiss' && note.value ? { note: note.value } : {}) }) });
      done.push(...batch);
      changed += answer?.candidates?.length ?? batch.length;
    }
    note.value = '';
    dismissDialog.value = false;
    if (ids.length > BATCH) notice.value = { type: 'success', text: `${many(changed, 'candidate')} ${word}.` };
    await load({ selection: afterAction(row) });
  } catch (err) {
    if (!done.length) {
      error.value = (err as Error).message;
      return;
    }
    const left = ids.length - done.length;
    note.value = '';
    dismissDialog.value = false;
    selected.value = selected.value.filter((id) => !done.includes(id));
    notice.value = { type: 'error', text: `${done.length.toLocaleString('en-US')} of ${many(ids.length, 'candidate')} ${word}, then: ${(err as Error).message}. The ${left.toLocaleString('en-US')} other${left === 1 ? ' stays' : 's stay'} ticked.` };
    await load({ selection: 'refresh' });
  }
}
// The dismiss dialog's: a row's candidate, else the selection.
function dismiss() {
  const c = target.value;
  return changeDismissal('dismiss', c ? [c.id] : selected.value, Boolean(c));
}

// Manual exclusions: a target group (a backend service), load balancer (a URL map) or account (a project) kept away from Dormeto (operators).
const excludeOptions = computed(() => (acting.value ? exclusionTargets(acting.value) : []));
const selectionExcludable = computed(() => Boolean(single.value && exclusionTargets(single.value).length));

async function exclude(body: object) {
  const row = Boolean(target.value);
  excludeOpen.value = false;
  try {
    const result = await api<{ candidates: number; operation: { id: string } }>('/exclusions', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `Excluded: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} updated; its managed workloads are being paused (operation ${result.operation.id}).`, operation: result.operation.id };
    await load({ selection: afterAction(row) });
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function lift(e: Exclusion) {
  try {
    const result = await api<{ candidates: number; operation: { id: string } }>(`/exclusions/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
    notice.value = { type: 'success', text: `Exclusion lifted: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} back; its workloads are being resumed (operation ${result.operation.id}).`, operation: result.operation.id };
    await load();
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

// Onboarding and offboarding: operations run by the workflow (Operations view).
const single = computed(() => (selected.value.length === 1 ? chosen.value[0] : undefined));
const onboardable = computed(() => single.value?.status === 'pending-onboarding');
// Refused by the API where the last run found the account's command role missing, or the account set up for discovery
// only: said here, before trying.
const noCommand = computed(() => onboardRefusal(access.value, single.value?.account));
// A GKE workload is offboarded with the CLI (the API refuses it through the manager).
const canOffboard = (c: Listed) => Boolean(c.workloadId) && ['managed', 'pending-offboarding'].includes(c.status) && !(isGoogle(c) && backendKind(c) === 'k8s');
const offboardable = computed(() => Boolean(single.value) && canOffboard(single.value!));
// An onboarding or offboarding running on a candidate, in words.
const runningText = (c: Listed & { operation: NonNullable<Listed['operation']> }) => `${operationLabel(c.operation.type, subjectOf(c))} is running`;

async function startOperation(body: { type: 'onboard' | 'offboard' } & Record<string, unknown>, c: Listed, subject: string, row: boolean) {
  try {
    const { operation } = await api<{ operation: { id: string } }>('/operations', { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `${operationLabel(body.type, subject)} started (operation ${operation.id}).`, operation: operation.id };
    // Shown running at once (the next refresh confirms it).
    c.operation = { id: operation.id, type: body.type };
    watch.watch(operation.id, body.type, subject);
    follow();
    if (!row) selected.value = [];
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
}

async function onboard(form: { name?: string; settings: Record<string, unknown>; databases: { kind: string; id: string }[]; tags?: Record<string, string> }) {
  const row = Boolean(target.value);
  const c = acting.value!;
  onboardOpen.value = false;
  await startOperation({ type: 'onboard', candidateId: c.id, ...form }, c, form.name ?? subjectOf(c), row);
}

// The one selected, or a row's (its menu's Offboard).
async function offboard(c: Listed = single.value!, row = false) {
  // The router the workload is on, as the candidate names it: a global Google Cloud load balancer has no region to find it by.
  const named = c.workload?.router;
  const routers = named ? [] : (await api<{ routers: RouterInfo[] }>('/routers')).routers;
  const router = named ?? routers.find((r) => r.account === c.account && r.region === c.region)?.name;
  if (!router) {
    notice.value = { type: 'error', text: `no router of the manager in ${c.account}/${c.region}` };
    return;
  }
  await startOperation({ type: 'offboard', router, workloadId: c.workloadId }, c, subjectOf(c), row);
}

onMounted(load);
onBeforeUnmount(() => {
  window.clearInterval(poll);
  window.clearInterval(following);
  window.clearTimeout(typing);
  window.clearTimeout(searchTyping);
  stopSearch();
});

const failed = computed(() => lastRun.value?.targets.filter((t) => t.status === 'error') ?? []);
// Account-regions scanned without any rule are counted, not listed (R4.5).
const scanned = computed(() => (lastRun.value?.targets.filter((t) => t.status === 'ok').length ?? 0) + (lastRun.value?.emptyPairs ?? 0));
// Skipped pairs are summarized per reason (older records listed them as targets).
const skipped = computed(() => lastRun.value?.skipped?.reduce((n, s) => n + s.pairs, 0) ?? lastRun.value?.targets.filter((t) => t.status === 'skipped').length ?? 0);
const seconds = computed(() => (lastRun.value ? Math.round((Date.parse(lastRun.value.finishedAt) - Date.parse(lastRun.value.startedAt)) / 1000) : null));
const selectedDismissed = computed(() => selected.value.length > 0 && chosen.value.length === selected.value.length && chosen.value.every((c) => c.status === 'dismissed'));
// A run's status as its mark (tables design §3): its icon in its color, the word its name.
const RUN_MARKS: Record<RunRecord['status'], { icon: string; color?: string }> = {
  running: { icon: mdiProgressClock, color: 'info' }, ok: { icon: mdiCheckCircleOutline, color: 'success' }, partial: { icon: mdiAlertOutline, color: 'warning' },
  failed: { icon: mdiAlertCircleOutline, color: 'error' }, skipped: { icon: mdiSkipNextCircleOutline },
};
// In account, region and id order (the index's): no other sort on the server. Each column's words: what an export prints (a
// status's word, where a rule is, the idle share with its ~ on Google Cloud, dates as ISO 8601).
const ruleWhere = (c: Listed): string[] => {
  if (c.kind === 'standalone') return ['standalone', resourceText(c)];
  const words = cloudWords(rowCloud(c));
  return isGoogle(c)
    ? [`${words.target} ${c.targetGroup}`, `${words.loadBalancer} ${c.loadBalancer}`, ...(c.lb ? [lbText(c.lb)] : [])]
    : [c.loadBalancer, c.listener, c.priority ? `priority ${c.priority}` : null, c.rules?.length > 1 ? `${c.rules.length} rules` : null].filter((s): s is string => Boolean(s));
};
const accountText = (c: Listed): string => {
  const cloud = cloudMark(rowCloud(c)).label;
  return c.accountName && c.accountName !== c.account ? `${c.accountName} (${cloud}, ${c.account})` : `${c.account} (${cloud})`;
};
const backendText = (c: Listed): string => {
  if (c.backend) return `${backendLabel(c.backend.kind, rowCloud(c))} ${isGoogle(c) ? c.backend.id : shortId(c.backend.id)}`;
  return c.workloadId ? `workload ${c.workload?.name ?? c.workloadId}` : '';
};
const reasonText = (c: Listed): string => {
  if (c.status === 'managed' && c.workload) return `managed as ${c.workload.name}`;
  return c.status === 'managed' && c.workloadId ? `managed as workload ${c.workloadId}` : c.statusReason;
};
const headers: DmHeader<Listed>[] = [
  { title: 'Status', key: 'status', sortable: false,
    text: (c) => [statusLabel(c.status), ...(c.operation ? [`${c.operation.type === 'onboard' ? 'onboarding' : 'offboarding'} running`] : [])].join(' · ') },
  { title: 'Rule', key: 'conditions', sortable: false, text: (c) => [c.kind === 'standalone' ? c.name : c.conditions, ...ruleWhere(c)].join(' · ') },
  { title: 'Account or project', key: 'account', sortable: false, text: accountText },
  { title: 'Region', key: 'region', sortable: false },
  { title: 'Backend', key: 'backend', sortable: false, text: backendText },
  { title: 'Idle (7 days)', key: 'idleHours7d', align: 'end', sortable: false, text: (c) => (c.idleHours7d === null ? '' : `${idleMark(c)}${idleShare(c)}`) },
  { title: 'Reason', key: 'statusReason', sortable: false, text: reasonText },
  { title: 'First seen', key: 'firstSeenAt', sortable: false },
];
// A row's "⋮" named by its rule (its first column is its status).
const ruleName = (c: Listed) => (c.kind === 'standalone' ? c.name : c.conditions);
// The PDF's title and lines: the status and the filters the table shows; a search's list cut, the line the file ends with.
const exported = computed<DmExport>(() => ({
  name: 'discovery', title: 'Discovery candidates',
  filters: [
    ...(status.value ? [`Status: ${statusLabel(status.value)}`] : []),
    ...(appliedCloud.value ? [`Account or project: ${applied.value.account}`] : []),
    ...(regionSent.value ? [`Region: ${applied.value.region}`] : []),
    ...(kindFilter.value ? [`Kind: ${kindInfo(kindFilter.value).title}`] : []),
  ],
  ...(searchMode.value && everythingCut.value ? { note: everythingCut.value } : {}),
}));

// A row's menu (operators): what the selection's buttons offer, for that candidate alone; the selection stays as it is. A
// running onboarding or offboarding says so instead, and an onboarding the API would refuse says why.
function actions(c: Listed): DmAction[] {
  if (!session.canOperate) return [];
  const out: DmAction[] = [];
  if (c.operation) {
    const running = runningText(c as Listed & { operation: NonNullable<Listed['operation']> });
    out.push({ title: c.operation.type === 'onboard' ? 'Onboarding…' : 'Offboarding…', icon: mdiProgressClock, disabled: true, help: `${running}: follow it in Operations.`, run: () => {} });
  } else {
    if (c.status === 'pending-onboarding') {
      const refusal = onboardRefusal(access.value, c.account);
      out.push({ title: 'Onboard…', icon: mdiPlusCircleOutline, disabled: Boolean(refusal), help: refusal ?? undefined, run: () => openFor(c, 'onboard') });
    }
    if (canOffboard(c)) out.push({ title: 'Offboard', icon: mdiLogoutVariant, run: () => void offboard(c, true) });
  }
  if (exclusionTargets(c).length) out.push({ title: 'Exclude…', icon: mdiCancel, color: 'error', run: () => openFor(c, 'exclude') });
  out.push(c.status === 'dismissed'
    ? { title: 'Restore', icon: mdiEyeOutline, run: () => void changeDismissal('restore', [c.id], true) }
    : { title: 'Dismiss…', icon: mdiEyeOffOutline, run: () => openFor(c, 'dismiss') });
  return out;
}
const first = computed(() => page.value * PAGE + (candidates.value.length ? 1 : 0));
const last = computed(() => page.value * PAGE + candidates.value.length);
// Presentation: the first answer not there yet (the status is set by it), the icon's mood while a run scans, the run's
// figures as tiles, and an icon per kind of exclusion.
const waiting = computed(() => loading.value && status.value === null);
const scanning = computed(() => running.value || lastRun.value?.status === 'running');
// The tiles' numbers count up when they arrive (the labels read the values themselves).
const secondsUp = useCountUp(() => seconds.value ?? 0);
const scannedUp = useCountUp(() => scanned.value);
const skippedUp = useCountUp(() => skipped.value);
const failedUp = useCountUp(() => failed.value.length);
const runTiles = computed(() => [
  { key: 'duration', icon: mdiTimerOutline, color: 'secondary', value: lastRun.value?.status === 'running' || seconds.value === null ? '—' : `${secondsUp.value} s`, label: 'duration' },
  { key: 'scanned', icon: mdiEarth, color: 'success', value: scannedUp.value, label: `account-region${scanned.value === 1 ? '' : 's'} scanned` },
  { key: 'skipped', icon: mdiSkipNextCircleOutline, color: 'info', value: skippedUp.value, label: 'skipped' },
  { key: 'failed', icon: mdiAlertCircleOutline, color: 'error', value: failedUp.value, label: 'failed' },
]);
const KIND_ICONS: Record<string, string> = { account: mdiOfficeBuildingOutline, 'load-balancer': mdiLanConnect, 'target-group': mdiTarget, resource: mdiServerOutline };
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-4">
    <PageTitle eyebrow="Organization" title="Discovery">
      <template #after>
        <InfoTip label="What discovery reads" test="discovery" :max-width="440">Load balancer rules of every account and region of the perimeter, read with the read-only
          <code>DmtDiscoveryRole</code>. Discovery runs on a schedule and on demand; idle shares are the hours without any request over the last 7 days.
          A Google Cloud project is read with the discovery service account of <code>dormeto gcp connect</code>; its idle share is estimated, as Google samples its load balancer metrics.</InfoTip>
      </template>
    </PageTitle>
    <v-spacer />
    <div class="d-flex flex-wrap align-center ga-2">
      <v-btn v-if="session.isAdmin" :prepend-icon="mdiCogOutline" variant="text" to="/discovery/settings">Perimeter</v-btn>
      <v-btn v-if="session.canOperate" :prepend-icon="mdiPlay" color="primary" variant="flat" :loading="running" :disabled="lastRun?.status === 'running'" @click="runNow">Run now</v-btn>
    </div>
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <NoticeToast :notice="notice" @close="notice = null" />

  <v-card class="dm-run mb-4" :loading="loading && !waiting">
    <div class="dm-run__sky" :data-mood="scanning ? 'load' : 'rest'" aria-hidden="true" />
    <DmLoader v-if="waiting" label="Reading the organization…" :size="56" />
    <v-card-text v-else-if="!lastRun" class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No discovery run yet.</span>
    </v-card-text>
    <v-card-text v-else class="dm-run__body">
      <div class="dm-run__icon">
        <DmLogo :state="scanning ? 'load' : 'wake'" :size="52" />
      </div>
      <div class="dm-run__main">
        <div class="dm-eyebrow">{{ lastRun.trigger }}<template v-if="lastRun.by"> by {{ lastRun.by }}</template></div>
        <div class="dm-run__headline">
          <span>Last run {{ relative(lastRun.startedAt, now) }}</span>
          <StatusMark :icon="RUN_MARKS[lastRun.status].icon" :color="RUN_MARKS[lastRun.status].color" :label="lastRun.status" :pulse="lastRun.status === 'running'" />
        </div>
        <div class="dm-run__tiles">
          <div v-for="t in runTiles" :key="t.key" class="dm-figure" :class="{ 'dm-figure--alarm': t.key === 'failed' && failed.length }">
            <v-avatar :color="t.color" variant="tonal" rounded="lg" size="34"><v-icon :icon="t.icon" size="18" /></v-avatar>
            <div class="dm-figure__text">
              <div class="dm-figure__value">{{ t.value }}</div>
              <div class="dm-figure__label">{{ t.label }}</div>
            </div>
          </div>
        </div>
        <v-alert v-if="lastRun.error" type="error" variant="tonal" density="compact" class="mt-4" :text="lastRun.error" />
        <p v-if="lastRun.skippedReason" class="text-body-medium text-medium-emphasis mt-3">Skipped: {{ lastRun.skippedReason }}.</p>
        <p v-if="refused" class="text-body-medium text-medium-emphasis mt-3">Run now {{ relative(refused.startedAt, now) }}<template v-if="refused.by"> by {{ refused.by }}</template> was refused: {{ refused.skippedReason }}.</p>
        <RunProblems :targets="lastRun.targets" />
        <ul v-if="failed.length" class="dm-run__failed mt-4">
          <li v-for="t in failed" :key="`${t.account}/${t.region}`" class="text-body-medium">
            <v-icon :icon="mdiAlertCircleOutline" color="error" size="16" class="dm-run__failed-icon" />
            <span class="text-error">{{ targetText(t) }}</span>
          </li>
        </ul>
      </div>
    </v-card-text>
  </v-card>

  <LintAlert v-if="lastRun" :findings="lastRun.lint" :settings-link="session.isAdmin" />
  <OrganizationAccess v-if="access && access.checkedAt" :report="access" :roles="roles" />

  <v-card class="dm-candidates">
    <div v-if="status" class="dm-candidates__tabs">
      <v-chip-group :model-value="status" mandatory column @update:model-value="show">
        <v-tooltip v-for="s in visibleStatuses(counts, status)" :key="s" location="top" max-width="380">
          <template #activator="{ props }">
            <v-chip v-bind="props" :value="s" :color="statusColor(s)" variant="tonal" size="default" class="dm-tab">{{ statusLabel(s) }}
              <span class="dm-tab__count">{{ counts[s] ?? 0 }}</span></v-chip>
          </template>
          <StatusHelp :status="s" />
        </v-tooltip>
      </v-chip-group>
    </div>
    <v-divider v-if="status" />
    <!-- The candidates of the status shown, a page at a time by the API's cursor (its own footer); while a search is in
         force, every one read and searched as one list with the table's pages. The filters and the selection's actions in
         the toolbar, each row's actions in its "⋮", the exports in the header's. -->
    <v-alert v-if="searchMode && everythingCut" data-test="discovery-search-cut" type="info" variant="tonal" density="compact" class="mx-4 mt-3" :text="everythingCut" />
    <DmTable v-model:selected="selected" v-model:search="search" class="dm-candidates__table" :headers="headers" :items="listed" :loading="loading || reading" item-value="id"
      :selectable="session.canOperate" :actions="actions" :row-name="ruleName" :server="searchMode ? undefined : server" :exported="exported">
      <template #toolbar>
        <v-text-field v-model="account" label="Account or project" placeholder="12 digits or project ID" density="compact" hide-details clearable max-width="220" class="dm-filter" @update:model-value="restartSoon" />
        <v-text-field v-model="region" label="Region" :placeholder="regionHint" density="compact" hide-details clearable max-width="180" class="dm-filter" :disabled="!filtered" @update:model-value="restartSoon" />
        <KindSelect :model-value="kindFilter" class="dm-filter dm-filter--kind" @update:model-value="filterByKind($event)" />
        <v-spacer />
        <div v-if="session.canOperate && selected.length" class="dm-candidates__actions">
          <v-tooltip v-if="single?.operation" location="top" max-width="380" :text="`${operationLabel(single.operation.type, subjectOf(single))} is running: follow it in Operations.`">
            <template #activator="{ props }">
              <span v-bind="props"><v-btn variant="tonal" disabled><template #prepend><v-progress-circular indeterminate size="16" width="2" /></template>{{ single.operation.type === 'onboard' ? 'Onboarding…' : 'Offboarding…' }}</v-btn></span>
            </template>
          </v-tooltip>
          <v-tooltip v-else-if="onboardable && noCommand" location="top" max-width="380" :text="noCommand">
            <template #activator="{ props }"><span v-bind="props"><v-btn :prepend-icon="mdiPlusCircleOutline" variant="tonal" disabled>Onboard…</v-btn></span></template>
          </v-tooltip>
          <v-btn v-else-if="onboardable" :prepend-icon="mdiPlusCircleOutline" color="primary" variant="flat" @click="openFor(null, 'onboard')">Onboard…</v-btn>
          <v-btn v-if="offboardable && !single?.operation" :prepend-icon="mdiLogoutVariant" color="warning" variant="tonal" @click="offboard()">Offboard</v-btn>
          <v-btn v-if="selectionExcludable" :prepend-icon="mdiCancel" color="error" variant="tonal" @click="openFor(null, 'exclude')">Exclude…</v-btn>
          <v-btn v-if="selectedDismissed" :prepend-icon="mdiEyeOutline" variant="tonal" @click="changeDismissal('restore')">Restore ({{ selected.length }})</v-btn>
          <v-btn v-else :prepend-icon="mdiEyeOffOutline" variant="tonal" @click="openFor(null, 'dismiss')">Dismiss ({{ selected.length }})</v-btn>
        </div>
      </template>
      <template #[`item.status`]="{ item }">
        <!-- An onboarding or offboarding running: its spinner alone, opening its steps; its words in the name and the tooltip. -->
        <v-tooltip v-if="item.operation" location="top" max-width="380" open-on-focus :text="`${operationLabel(item.operation.type, subjectOf(item))} is running: open its steps in Operations.`">
          <template #activator="{ props }">
            <router-link v-bind="props" :to="{ path: '/operations', query: { id: item.operation.id } }" class="dm-running"
              :aria-label="`${operationLabel(item.operation.type, subjectOf(item))} running: follow it in Operations`">
              <v-progress-circular indeterminate size="18" width="2" color="primary" aria-hidden="true" />
            </router-link>
          </template>
        </v-tooltip>
        <DiscoveryStatusChip v-else :status="item.status" />
      </template>
      <template #[`item.conditions`]="{ item }">
        <div v-if="isStandalone(item) && item.kind === 'standalone'" class="dm-rule">
          <div class="dm-rule__host">{{ item.name }}<KindMark kind="standalone" class="ml-1" /></div>
          <div class="dm-rule__where mono" data-test="standalone-resource">{{ resourceText(item) }}</div>
        </div>
        <div v-else class="dm-rule">
          <!-- A host breaks after its dots (and its hyphens) rather than inside a word. -->
          <div class="dm-rule__host"><template v-for="(part, i) in (item.conditions ?? '').split('.')" :key="i">{{ i ? '.' : '' }}<wbr v-if="i">{{ part }}</template></div>
          <div v-if="isGoogle(item)" class="dm-rule__where" data-test="google-rule">
            backend service <component :is="mapLink(item) ? 'a' : 'span'" :href="mapLink(item) ?? undefined" target="_blank" rel="noopener" class="mono">{{ item.targetGroup }}</component>
            · URL map <component :is="mapLink(item) ? 'a' : 'span'" :href="mapLink(item) ?? undefined" target="_blank" rel="noopener" class="mono">{{ item.loadBalancer }}</component>
            <template v-if="item.lb"> · {{ lbText(item.lb) }}</template>
          </div>
          <div v-else class="dm-rule__where">{{ item.loadBalancer }} · {{ item.listener }} · priority {{ item.priority }}
            <v-tooltip v-if="(item.rules?.length ?? 0) > 1" location="top" max-width="520">
              <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="tonal" class="ml-1" tabindex="0">{{ item.rules!.length }} rules</v-chip></template>
              <div v-for="line in ruleLines(item.rules!)" :key="line">{{ line }}</div>
            </v-tooltip>
          </div>
        </div>
      </template>
      <template #[`item.account`]="{ item }">
        <div class="nowrap">{{ item.accountName }}</div>
        <div class="text-body-small text-medium-emphasis mono"><CloudMark :cloud="rowCloud(item)" class="mr-1" />{{ item.account }}</div>
      </template>
      <template #[`item.region`]="{ item }"><RegionLabel :region="item.region" /></template>
      <template #[`item.backend`]="{ item }">
        <span v-if="item.backend && isGoogle(item)" class="d-inline-flex align-center ga-2"><BackendKinds :kinds="[item.backend.kind]" cloud="gcp" /><span class="mono nowrap">{{ item.backend.id }}</span></span>
        <BackendLabel v-else-if="item.backend" :backend="item.backend" :account="item.account" :region="item.region" />
        <span v-else-if="item.workloadId" class="text-medium-emphasis">workload {{ item.workload?.name ?? item.workloadId }}</span>
      </template>
      <template #[`item.idleHours7d`]="{ item }">
        <!-- The ~ says a Google Cloud share is estimated (the user, 2026-11-12); the bar's tooltip says why. -->
        <div v-if="item.idleHours7d !== null" class="dm-idle">
          <span class="dm-idle__share" aria-hidden="true">{{ idleMark(item) }}{{ idleShare(item) }}</span>
          <IdleBar :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d ?? null" :cloud="rowCloud(item)" :resource="resourceOf(item)" />
        </div>
      </template>
      <template #[`item.statusReason`]="{ item }">
        <div class="dm-reason">
          <span v-if="item.status === 'managed' && item.workload" class="text-medium-emphasis">managed as
            <router-link :to="`/workloads/${item.workload.router}/${item.workload.workloadId}`">{{ item.workload.name }}</router-link></span>
          <span v-else class="text-medium-emphasis">{{ reasonText(item) }}</span>
        </div>
      </template>
      <template #[`item.firstSeenAt`]="{ item }"><span class="nowrap text-medium-emphasis dm-num">{{ relative(item.firstSeenAt, now) }}</span></template>
      <template #loading>
        <DmLoader label="Reading the candidates…" :size="40" class="dm-candidates__loader" />
      </template>
      <template #no-data>
        <div class="dm-calm justify-center py-6">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">No candidate here.</span>
        </div>
      </template>
      <!-- The cursor's pager (a search's list has the table's own): a click while a page loads is ignored. -->
      <template v-if="!searchMode" #bottom>
        <v-divider />
        <nav class="dm-candidates__foot" aria-label="Pages of candidates">
          <span role="status" class="text-body-small text-medium-emphasis dm-num">{{ first }}–{{ last }}<template v-if="!appliedCloud && status && !kindFilter"> of {{ counts[status] ?? 0 }} (at the last change)</template></span>
          <v-spacer />
          <v-btn variant="text" :prepend-icon="mdiChevronLeft" :disabled="page === 0" @click="turn(-1)">Previous</v-btn>
          <v-btn variant="text" :append-icon="mdiChevronRight" :disabled="!hasNext" @click="turn(1)">Next</v-btn>
        </nav>
      </template>
    </DmTable>
  </v-card>

  <v-card id="exclusions" class="mt-4" title="Exclusions">
    <v-card-subtitle class="text-wrap">Target groups and backend services, load balancers and URL maps, accounts and projects kept away from Dormeto: discovery never
      proposes them, whatever the perimeter includes, and the managed workloads they match stay awake until offboarded.</v-card-subtitle>
    <v-list v-if="exclusions.length" lines="three" class="bg-transparent">
      <v-list-item v-for="e in exclusions" :key="e.id" :title="exclusionText(e.target)">
        <template #prepend>
          <v-avatar color="error" variant="tonal" rounded="lg" size="36" class="mr-1"><v-icon :icon="KIND_ICONS[e.target.kind] ?? mdiCancel" size="18" /></v-avatar>
        </template>
        <v-list-item-subtitle class="text-wrap">
          {{ e.reason }} · by {{ e.by }} {{ relative(e.at, now) }} · {{ e.expiresAt ? (e.expired ? `expired ${relative(e.expiresAt, now)}` : `expires ${relative(e.expiresAt, now)}`) : 'no expiry' }}
          <template v-if="e.paused?.length"> · {{ e.lifting ? 'still to resume' : 'paused' }} {{ e.paused.map((p) => `${p.name ?? p.workloadId} (${p.router})`).join(', ') }}</template>
        </v-list-item-subtitle>
        <template #append>
          <div class="d-flex flex-wrap align-center justify-end ga-2">
            <!-- Its state as an icon alone (tables design §3), the word its name and its tooltip's first line. -->
            <StatusMark v-if="e.expired" :icon="mdiTimerOffOutline" label="expired">
              <div class="text-body-medium mt-1">Its expiry has passed.</div>
            </StatusMark>
            <StatusMark v-if="e.lifting" :icon="mdiAlertOutline" color="warning" label="lift incomplete">
              <div class="text-body-medium mt-1">Lifted, some of its workloads not resumed yet: Retry lift tries again.</div>
            </StatusMark>
            <v-btn v-if="session.canOperate" variant="tonal" size="small" @click="lift(e)">{{ e.lifting ? 'Retry lift' : 'Lift' }}</v-btn>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-card-text v-else class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No exclusion. Select a candidate and choose Exclude to keep it, its load balancer or its account or project away from Dormeto.</span>
    </v-card-text>
  </v-card>

  <ExcludeDialog v-model="excludeOpen" :options="excludeOptions" @submit="exclude" />
  <OnboardDialog v-model="onboardOpen" :title="(acting?.kind === 'standalone' ? acting.name : acting?.conditions) ?? ''" :default-name="(acting?.kind === 'standalone' ? acting.name : acting?.targetGroup) ?? null" :resource="acting ? resourceOf(acting) ?? null : null" :kubernetes="actingKubernetes" :access="clusterAccess" :aws-tags="acting?.tags" :cloud="acting ? rowCloud(acting) : 'aws'" :routers="projectRouters" :choose-router="chooseRouter" :backend-kind="acting ? backendKind(acting) ?? null : null" @submit="onboard" />

  <v-dialog v-model="dismissDialog" max-width="480">
    <v-card class="dm-dialog">
      <v-card-item>
        <template #prepend>
          <v-avatar color="info" variant="tonal" rounded="lg" size="40"><v-icon :icon="mdiEyeOffOutline" size="20" /></v-avatar>
        </template>
        <v-card-title>Dismiss candidates</v-card-title>
      </v-card-item>
      <v-card-text>
        <p class="mb-4">{{ target ? `The rule ${target.conditions}` : `The ${selected.length} selected rule${selected.length === 1 ? '' : 's'}` }} will stay dismissed, whatever later scans find, until restored.</p>
        <v-text-field v-model="note" label="Note (why)" maxlength="256" counter />
      </v-card-text>
      <v-card-actions class="px-6 pb-5">
        <v-spacer />
        <v-btn variant="text" @click="dismissDialog = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" @click="dismiss()">Dismiss</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
/* An onboarding or offboarding running: its spinner, a link to its steps. */
.dm-running { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; border-radius: 50%; text-decoration: none; }
.dm-running:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
/* Readable over the page: the overlay's glass, nearly opaque (the global glass of cards would let the page through). */
.v-card.dm-dialog:not(.v-card--variant-text):not(.v-card--variant-plain) { background: rgba(var(--v-theme-surface), 0.95) !important; }
.dm-num { font-variant-numeric: tabular-nums; }
/* An empty state: the sleeping icon and its sentence, centred in its card. */
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding-block: 24px !important; }

/* The last run: the icon (its sun turns while a run scans), the figures as tiles. */
.dm-run { position: relative; overflow: hidden; }
.dm-run__sky { position: absolute; inset: 0; pointer-events: none; transition: opacity 1.2s;
  background: radial-gradient(55% 140% at 0% 0%, rgba(var(--v-theme-primary), 0.12), transparent 65%), radial-gradient(40% 100% at 100% 100%, rgba(var(--v-theme-sun), 0.07), transparent 70%); }
.dm-run__sky[data-mood="load"] { background: radial-gradient(55% 140% at 0% 0%, rgba(var(--v-theme-primary), 0.22), transparent 65%), radial-gradient(40% 100% at 100% 100%, rgba(var(--v-theme-sun), 0.14), transparent 70%); }
.dm-run__body { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 24px; align-items: start; padding: 24px !important; }
.dm-run__icon { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.2); }
.dm-run__headline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 4px 0 16px; font-size: clamp(1.2rem, 1rem + 0.7vw, 1.5rem); font-weight: 600;
  letter-spacing: -0.03em; line-height: 1.2; }
.dm-run__tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dm-figure { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 10px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px;
  background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-figure--alarm { border-color: rgba(var(--v-theme-error), 0.4); background: rgba(var(--v-theme-error), 0.06); }
.dm-figure__text { min-width: 0; }
.dm-figure__value { font-size: 1.45rem; font-weight: 600; line-height: 1.05; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
.dm-figure__label { font-size: 0.78rem; line-height: 1.25; opacity: 0.66; }
.dm-run__failed { list-style: none; display: grid; gap: 6px; margin-bottom: 0; padding: 0; }
.dm-run__failed li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: 12px; background: rgba(var(--v-theme-error), 0.06); }
.dm-run__failed-icon { margin-top: 2px; }

/* The candidates: status tabs with their counts, filters and actions, the table. */
.dm-candidates { overflow: hidden; }
.dm-candidates__tabs { padding: 10px 14px 4px; }
.dm-tab { font-weight: 500; }
.dm-tab__count { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.08); font: 500 0.72rem/1.4 var(--dm-mono);
  font-variant-numeric: tabular-nums; }
.dm-tab.v-chip--selected .dm-tab__count, .dm-tab.v-chip--active .dm-tab__count { background: rgba(var(--v-theme-on-surface), 0.12); }
.dm-filter { flex: 1 1 160px; }
/* Kind: the width of its longest choice with its icon. */
.dm-filter--kind { flex: 0 0 172px; }
.dm-candidates__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* The table's own footer: where the page is in the list, and the cursor's Previous and Next. */
.dm-candidates__foot { display: flex; align-items: center; gap: 8px; padding: 8px 16px; }
.dm-candidates__loader { padding: 28px 16px; }
.dm-candidates__table :deep(th) { padding-inline: 8px !important; }
.dm-candidates__table :deep(td) { padding: 10px 8px !important; vertical-align: middle; }
.dm-candidates__table :deep(th:first-child), .dm-candidates__table :deep(td:first-child) { padding-left: 16px !important; }
.dm-candidates__table :deep(.backend-label .mono) { display: inline-block; max-width: 104px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.dm-rule { min-width: 140px; max-width: 280px; }
.dm-rule__host { font-weight: 500; overflow-wrap: break-word; }
.dm-rule__where { margin-top: 2px; font-size: 0.78rem; opacity: 0.62; }
.dm-reason { min-width: 90px; max-width: 260px; }
.dm-idle { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dm-idle__share { min-width: 3.4em; text-align: right; font: 500 0.74rem/1 var(--dm-mono); font-variant-numeric: tabular-nums; opacity: 0.75; }
.dm-idle :deep(.idle-bar) { width: 44px; margin-left: 0; }
.dm-idle :deep(.v-progress-linear) { border-radius: 999px; }
.dm-idle :deep(.v-progress-linear__background) { opacity: 0.14; }
.dm-idle :deep(.v-progress-linear__determinate) { border-radius: 999px; }

@media (max-width: 960px) {
  .dm-run__tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  /* A phone's filters stacked, each the full width. */
  .dm-filter, .dm-filter--kind { flex: 1 1 100%; max-width: none !important; }
  .dm-run__body { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 18px !important; }
  .dm-run__icon { width: 68px; height: 68px; }
  .dm-candidates__actions { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-run__sky { transition: none; }
}
</style>
