// The waiting page in the demo (router 0.35.0): the three levels' routes, validated as the router words them (the main
// refusals), the rights of design §11 (a custom page is the administrators', at every level), and the resolution by field.
import { DESCRIPTION_MAX, HTML_BYTES, ICON_BYTES, TITLE_MAX, type EffectivePage, type StoredPage, type WaitingPageView } from '../waiting-page';
import { audited, fail, routerOf, workloadOf, type Demo, type DemoRouter, type DemoWorkload, type StoredWaitingPage } from './state';
import { hex, iso } from './util';

type Body = Record<string, unknown>;
const FIELDS = { template: ['icon', 'title', 'description'], custom: ['html'] } as const;
const ICON = /^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,[A-Za-z0-9+/]*={0,2}$/;
const chars = (s: string) => [...s].length;

function problems(page: Body): string[] {
  const mode = page.mode;
  if (mode !== 'template' && mode !== 'custom') return ['mode must be template or custom'];
  const out = Object.keys(page).filter((k) => k !== 'mode' && !(FIELDS[mode] as readonly string[]).includes(k)).map((k) => `${k} is not a field of a ${mode} page`);
  const { icon, title, description, html } = page;
  if (icon !== undefined && icon !== 'auto' && icon !== 'none' && !(typeof icon === 'string' && ICON.test(icon) && icon.length * 0.75 <= ICON_BYTES + 3)) out.push('icon must be auto, none, or a data:image/png, jpeg, webp, svg+xml or x-icon base64 URI of at most 64 KiB');
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || /[\n\r]/.test(title))) out.push('title must be one line of text');
  else if (typeof title === 'string' && chars(title) > TITLE_MAX) out.push(`title must be at most ${TITLE_MAX} characters`);
  if (description !== undefined && (typeof description !== 'string' || !description.trim())) out.push('description must be text');
  else if (typeof description === 'string' && chars(description) > DESCRIPTION_MAX) out.push(`description must be at most ${DESCRIPTION_MAX} characters`);
  if (mode === 'custom') {
    if (typeof html !== 'string' || !html.trim()) out.push(html === undefined ? 'html is required in a custom page' : 'html must be a page, not blank');
    else if (new TextEncoder().encode(html).length > HTML_BYTES) out.push('html must be at most 256 KiB');
  }
  return out;
}

const warningsOf = (page: StoredPage | null): string[] => (page?.mode === 'custom' && !/data-dormeto\s*=\s*["']?status/i.test(page.html)
  ? ['the page has no element data-dormeto="status": the visitor will not read why it waits'] : []);

// The effective page: the most specific level with a document decides the mode; a template takes each field from the most specific template.
function resolve(levels: [string, StoredPage | null][]): EffectivePage {
  const documents = levels.filter((l): l is [string, StoredPage] => l[1] !== null);
  if (!documents.length) return { mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } };
  const [deciding, first] = documents[0]!;
  if (first.mode === 'custom') return { mode: 'custom', html: first.html, from: { mode: deciding, html: deciding } };
  const page: EffectivePage = { mode: 'template', from: { mode: deciding } };
  for (const key of FIELDS.template) {
    const found = documents.find(([, p]) => p.mode === 'template' && p[key] !== undefined);
    if (found) { (page as Record<string, unknown>)[key] = (found[1] as Record<string, unknown>)[key]; page.from[key] = found[0]; } else if (key === 'icon') { page.icon = 'auto'; page.from.icon = 'default'; }
  }
  return page;
}

const hasWaitingPage = (r: DemoRouter): boolean => {
  const [major, minor] = r.version.split('.').map(Number);
  return major! > 0 || minor! >= 35;
};
const needRouter = (r: DemoRouter) => { if (!hasWaitingPage(r)) fail(409, 'conflict', 'upgrade the router to 0.35.0'); };
const isAdmin = (d: Demo) => (d.me.effectiveRole ?? d.me.role) === 'admin';
const canOperate = (d: Demo) => isAdmin(d) || (d.me.effectiveRole ?? d.me.role) === 'operator';

function view(d: Demo, router: DemoRouter, w: DemoWorkload | null): WaitingPageView {
  const org = d.waitingPage.page;
  const own = (w ? w.page : router.page)?.page ?? null;
  const upper = router.page?.page ?? null;
  const stored = w ? w.page : router.page;
  const effective = w ? resolve([['workload', own], ['router', upper], ['organization', org]]) : resolve([['router', own], ['organization', org]]);
  const inherited = w ? resolve([['router', upper], ['organization', org]]) : resolve([['organization', org]]);
  return {
    own, inherited, effective, from: effective.from, ...(w ? { favicon: w.favicon } : {}), warnings: warningsOf(own),
    terraform: Boolean(w && w.source === 'terraform'), by: stored?.by ?? null, at: stored ? iso(stored.at) : null,
  };
}

const text = (level: string, page: StoredPage | null): string => {
  if (!page) return `${level} cleared`;
  if (page.mode !== 'custom') return `${level} ${page.mode}`;
  return `${level} custom, ${new TextEncoder().encode(page.html).length} bytes, sha256 ${hex(page.html, 64)}`;
};

const pageIn = (body: Body): Body => {
  if (typeof body.page !== 'object' || body.page === null || Array.isArray(body.page)) fail(400, 'bad_request', 'page must be an object');
  return body.page as Body;
};

// Every level: the rights first (design §11), then the page.
function write(d: Demo, level: 'organization' | 'router' | 'workload', target: string, body: Body | null, stored: StoredPage | null, store: (page: StoredPage | null) => void) {
  const name = body ? 'waiting-page' : 'waiting-page-clear';
  return audited(d, name, target, () => {
    const page = body ? (pageIn(body) as unknown as StoredPage) : null;
    if (!(level === 'workload' ? canOperate(d) : isAdmin(d))) fail(403, 'forbidden', `your role cannot change the waiting page of a ${level}`);
    if (!isAdmin(d) && ((page && page.mode !== 'template') || (stored && stored.mode !== 'template'))) {
      fail(403, 'forbidden', "your role cannot change a custom page: it runs scripts on the application's own address");
    }
    if (page) {
      const found = problems(page as unknown as Body);
      if (found.length) fail(400, 'bad_request', found.join('; '));
    }
    store(page);
    return { result: text(level, page), response: page };
  });
}

export function organizationPage(d: Demo) {
  const { page, updatedAt, updatedBy } = d.waitingPage;
  return { page, warnings: warningsOf(page), updatedAt, updatedBy };
}

export function setOrganizationPage(d: Demo, body: Body | null, now: number) {
  write(d, 'organization', 'organization', body, d.waitingPage.page, (page) => { d.waitingPage = { page, updatedAt: iso(now), updatedBy: d.me.email }; });
  return { ...organizationPage(d), note: 'routers read it within about a minute' };
}

export function routerPage(d: Demo, name: string, method: string, body: Body, now: number): WaitingPageView {
  const router = routerOf(d, name);
  needRouter(router);
  if (method !== 'GET') {
    write(d, 'router', name, method === 'PUT' ? body : null, router.page?.page ?? null, (page) => { router.page = page ? { page, by: d.me.email, at: now } : null; });
  }
  return view(d, router, null);
}

export function workloadPage(d: Demo, routerName: string, id: string, method: string, body: Body, now: number): WaitingPageView {
  const w = workloadOf(d, routerName, id);
  const router = routerOf(d, routerName);
  needRouter(router);
  if (method !== 'GET') {
    if (w.source === 'terraform' && (method === 'PUT' || !w.page?.by)) fail(409, 'conflict', `workload ${id} was written by Terraform: set waiting_page in its workload module`);
    write(d, 'workload', `${routerName}/${id}`, method === 'PUT' ? body : null, w.page?.page ?? null, (page) => { w.page = page ? { page, by: d.me.email, at: now } : null; });
  }
  return view(d, router, w);
}
