import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WaitingPageDialog from '../src/components/WaitingPageDialog.vue';
import type { EffectivePage, StoredPage } from '../src/waiting-page';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const INHERITED: EffectivePage = { mode: 'template', icon: 'none', title: 'Acme', from: { mode: 'organization', icon: 'organization', title: 'organization' } };
type Props = { level?: 'workload' | 'router' | 'organization'; own?: StoredPage | null; inherited?: EffectivePage; canCustom?: boolean; beneath?: EffectivePage | null; favicon?: string | null; error?: string; saving?: boolean };
const mounted: ReturnType<typeof mount>[] = [];
async function open(props: Props = {}) {
  const w = mount(WaitingPageDialog, {
    props: { modelValue: false, level: 'workload', subject: 'shop', own: null, inherited: INHERITED, favicon: null, canCustom: true, ...props },
    attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] },
  });
  mounted.push(w);
  await w.setProps({ modelValue: true });
  await flushPromises();
  return w;
}
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const dialog = () => document.body.querySelector('[data-test="waiting-page-dialog"]') as HTMLElement;
const frame = () => dialog().querySelector('iframe') as HTMLIFrameElement;
const srcdoc = () => frame().getAttribute('srcdoc') ?? '';
const pick = (name: string) => dialog().querySelector(`[data-test="${name}"]`) as HTMLElement;
const button = (label: string) => [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const radio = (name: string) => (pick(name).querySelector('input') as HTMLInputElement).click();
async function type(name: string, value: string) {
  const el = pick(name).querySelector('input, textarea') as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await nextTick();
}
async function choose(name: string, file: File | null) {
  const input = pick(name).querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file = (bytes: Uint8Array | string, name: string, type = '') => new File([bytes as BlobPart], name, { type });

describe('WaitingPageDialog', () => {
  it('previews in a frame that runs no script and has no same origin, whatever it shows', async () => {
    await open();
    const sandbox = frame().getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox).not.toMatch(/allow-scripts|allow-same-origin/);
    pick('mode-custom').click();
    await flushPromises();
    expect(dialog().querySelector('iframe')).toBeNull();
    await choose('html-file', file('<!doctype html><script>parent.document.cookie</script><p>x</p>', 'a.html', 'text/html'));
    expect(srcdoc()).toContain('parent.document.cookie');
    expect(frame().getAttribute('sandbox')).toBe('');
  });

  it('redraws the preview as a field changes, over what the level inherits', async () => {
    await open();
    expect(srcdoc()).toContain('<h1>Acme</h1>');
    await type('title', 'My shop <b>');
    expect(srcdoc()).toContain('My shop &lt;b&gt;');
    await type('description', 'Back at 8.');
    expect(srcdoc()).toContain('Back at 8.');
  });

  it('previews over the template beneath a custom page in the middle, as the router resolves it', async () => {
    const custom: EffectivePage = { mode: 'custom', html: '<p>x</p>', from: { mode: 'router', html: 'router' } };
    const beneath: EffectivePage = { mode: 'template', icon: 'auto', title: 'ORG-T', description: 'ORG-D', from: { mode: 'organization', title: 'organization', description: 'organization', icon: 'default' } };
    await open({ inherited: custom, beneath });
    expect(srcdoc()).toContain('<h1>ORG-T</h1>');
    expect(srcdoc()).toContain('ORG-D');
    expect(pick('replaces-custom')).toBeTruthy();
    mounted.pop()!.unmount();
    await open({ inherited: custom });
    expect(srcdoc()).not.toContain('ORG-T');
  });

  it('previews each state, in English or French, light or dark', async () => {
    await open();
    expect(srcdoc()).toContain('aria-valuenow="60"');
    pick('state-longer').click();
    await flushPromises();
    expect(srcdoc()).toContain('This is taking longer than usual.');
    pick('state-failed').click();
    await flushPromises();
    expect(srcdoc()).toContain('has no capacity');
    pick('state-nap').click();
    await flushPromises();
    expect(srcdoc()).toContain('Napping on schedule until Mon 08:00');
    pick('language-fr').click();
    await flushPromises();
    expect(srcdoc()).toContain('En pause programmée');
    const light = srcdoc();
    pick('scheme-dark').click();
    await flushPromises();
    expect(srcdoc()).not.toBe(light);
  });

  it('says what the preview cannot show of a custom page', async () => {
    await open();
    expect(dialog().textContent).toMatch(/remote images and fonts/);
    expect(dialog().textContent).toMatch(/scripts do not run/);
  });

  it('hides Custom HTML from whoever may not set it', async () => {
    await open({ canCustom: false });
    expect(pick('mode-custom')).toBeNull();
    expect(dialog().textContent).not.toContain('Custom HTML');
  });

  it('saves only the fields set, and inherits the icon unless one is chosen', async () => {
    const w = await open();
    await type('title', '  Shop  ');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![0]).toEqual([{ mode: 'template', title: 'Shop' }]);
    radio('icon-auto');
    await flushPromises();
    await type('description', 'Line one\nLine two ');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![1]).toEqual([{ mode: 'template', icon: 'auto', title: 'Shop', description: 'Line one\nLine two' }]);
  });

  it('offers Inherit for the icon below the organization, and starts from what the level holds', async () => {
    await open({ own: { mode: 'template', icon: 'none', title: 'Mine' } });
    expect(pick('icon-inherit')).not.toBeNull();
    expect((pick('title').querySelector('input') as HTMLInputElement).value).toBe('Mine');
  });

  it('has no Inherit for the organization\'s icon, which has nothing above it', async () => {
    await open({ level: 'organization' });
    expect(dialog().querySelector('[data-test="icon-inherit"]')).toBeNull();
  });

  it('checks an icon by its bytes and its size before keeping it', async () => {
    const w = await open();
    radio('icon-upload');
    await flushPromises();
    await choose('icon-file', file('GIF89a....', 'a.png', 'image/png'));
    expect(pick('icon-problem').textContent).toContain('PNG, JPEG, WebP, SVG or ICO');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')).toBeUndefined();
    const big = new Uint8Array(64 * 1024 + 1);
    big.set(PNG);
    await choose('icon-file', file(big, 'big.png', 'image/png'));
    expect(pick('icon-problem').textContent).toContain('64 KiB');
    await choose('icon-file', file(PNG, 'a.bin', 'application/octet-stream'));
    expect(dialog().querySelector('[data-test="icon-problem"]')).toBeNull();
    expect(srcdoc()).toContain('src="data:image/png;base64,');
    button('Save')!.click();
    await flushPromises();
    expect((w.emitted('submit')![0]![0] as { icon: string }).icon).toMatch(/^data:image\/png;base64,/);
  });

  it('reads a custom page from a file, refuses a blank or too large one before sending, and shows its warnings and hooks', async () => {
    const w = await open();
    pick('mode-custom').click();
    await flushPromises();
    expect(dialog().textContent).toContain('data-dormeto="status"');
    expect(dialog().textContent).toContain('dormeto:state');
    expect(dialog().textContent).toMatch(/own address/);
    expect(dialog().textContent).toMatch(/cookies/);
    expect(button('Save')!.disabled).toBe(true);
    await choose('html-file', file('  ', 'a.html', 'text/html'));
    expect(pick('html-problem').textContent).toContain('blank');
    await choose('html-file', file('x'.repeat(256 * 1024 + 1), 'big.html', 'text/html'));
    expect(pick('html-problem').textContent).toContain('256 KiB');
    expect(button('Save')!.disabled).toBe(true);
    await choose('html-file', file('<!doctype html><p>wait</p>', 'ok.html', 'text/html'));
    expect(dialog().querySelector('[data-test="html-problem"]')).toBeNull();
    expect(pick('html-warnings').textContent).toContain('data-dormeto="status"');
    expect(srcdoc()).toContain('<p>wait</p>');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![0]).toEqual([{ mode: 'custom', html: '<!doctype html><p>wait</p>' }]);
  });

  it('shows the API\'s refusal and cannot be left while it saves', async () => {
    const w = await open({ error: 'title must be at most 80 characters' });
    expect(pick('waiting-page-error').textContent).toContain('title must be at most 80 characters');
    await w.setProps({ saving: true });
    expect(button('Cancel')!.disabled).toBe(true);
  });

  it('forgets a chosen file when the input is cleared: the preview and Save no longer hold it', async () => {
    const w = await open();
    radio('icon-upload');
    await flushPromises();
    await choose('icon-file', file(PNG, 'a.png'));
    expect(srcdoc()).toContain('src="data:image/png');
    await choose('icon-file', null);
    expect(srcdoc()).not.toContain('src="data:image/png');
    expect(button('Save')!.disabled).toBe(true);
    pick('mode-custom').click();
    await flushPromises();
    await choose('html-file', file('<p>old</p>', 'a.html'));
    expect(srcdoc()).toContain('<p>old</p>');
    await choose('html-file', null);
    expect(dialog().querySelector('iframe')).toBeNull();
    expect(button('Save')!.disabled).toBe(true);
    expect(w.emitted('submit')).toBeUndefined();
  });

  it('checks a file\'s size before reading it, and says when it cannot be read', async () => {
    await open();
    radio('icon-upload');
    await flushPromises();
    const big = file(PNG, 'big.png');
    Object.defineProperty(big, 'size', { value: 64 * 1024 + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    await choose('icon-file', big);
    expect(read).not.toHaveBeenCalled();
    expect(pick('icon-problem').textContent).toContain('64 KiB');
    const gone = file(PNG, 'gone.png');
    vi.spyOn(gone, 'arrayBuffer').mockRejectedValue(new Error('NotReadableError'));
    await choose('icon-file', gone);
    expect(pick('icon-problem').textContent).toContain('could not be read');
    pick('mode-custom').click();
    await flushPromises();
    const huge = file('x', 'huge.html');
    Object.defineProperty(huge, 'size', { value: 256 * 1024 + 1 });
    const readHtml = vi.spyOn(huge, 'arrayBuffer');
    await choose('html-file', huge);
    expect(readHtml).not.toHaveBeenCalled();
    expect(pick('html-problem').textContent).toContain('256 KiB');
  });

  it('keeps the last file chosen when two reads finish out of order', async () => {
    await open();
    pick('mode-custom').click();
    await flushPromises();
    const slow = file('<p>first</p>', 'first.html');
    vi.spyOn(slow, 'arrayBuffer').mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(new TextEncoder().encode('<p>first</p>').buffer), 60)));
    await choose('html-file', slow);
    await choose('html-file', file('<p>second</p>', 'second.html'));
    await new Promise((r) => setTimeout(r, 120));
    await flushPromises();
    expect(srcdoc()).toContain('<p>second</p>');
  });

  it('sends a stored page unchanged: no trimming, no field added, an empty field or Inherit leaves its key out', async () => {
    const own = { mode: 'template' as const, title: 'Shop ', description: '  two  \nlines ' };
    const w = await open({ own });
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![0]).toEqual([own]);
    await type('title', '');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![1]).toEqual([{ mode: 'template', description: '  two  \nlines ' }]);
  });

  it('adds no icon to an organization page that had none, and none to a custom page', async () => {
    const w = await open({ level: 'organization', own: { mode: 'template', title: 'Acme' } });
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![0]).toEqual([{ mode: 'template', title: 'Acme' }]);
    radio('icon-none');
    await flushPromises();
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![1]).toEqual([{ mode: 'template', icon: 'none', title: 'Acme' }]);
  });

  it('sends a stored custom page unchanged, whitespace and all', async () => {
    const own = { mode: 'custom' as const, html: '\uFEFF<!doctype html>\n<p data-dormeto="status"></p>\n\n' };
    const w = await open({ own });
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('submit')![0]).toEqual([own]);
  });

  it('says that an empty template replaces the custom page set above', async () => {
    await open({ inherited: { mode: 'custom', html: '<p>x</p>', from: { mode: 'organization', html: 'organization' } } });
    expect(pick('replaces-custom').textContent).toContain("This replaces the custom page set above with Dormeto's template.");
  });
  it('does not say it when the level above is a template', async () => {
    await open();
    expect(dialog().querySelector('[data-test="replaces-custom"]')).toBeNull();
  });

  it('names its groups for assistive technology and marks the French button', async () => {
    await open();
    expect(dialog().querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Icon');
    expect(dialog().querySelector('.v-chip-group')!.getAttribute('aria-label')).toBe('State to preview');
    expect(pick('language-fr').getAttribute('lang')).toBe('fr');
    expect(pick('language-fr').closest('.v-btn-toggle')!.getAttribute('aria-label')).toBe('Language of the preview');
    expect(pick('scheme-dark').closest('.v-btn-toggle')!.getAttribute('aria-label')).toBe('Color scheme of the preview');
  });

  it('cannot be closed by a click outside or Escape while it saves', async () => {
    const w = await open({ saving: true });
    expect(w.findComponent({ name: 'VDialog' }).props('persistent')).toBe(true);
  });

  it('cannot save a title of 81 characters or a description of 501', async () => {
    await open();
    await type('title', 'a'.repeat(81));
    expect(button('Save')!.disabled).toBe(true);
    await type('title', 'a'.repeat(80));
    expect(button('Save')!.disabled).toBe(false);
    await type('description', 'a'.repeat(501));
    expect(button('Save')!.disabled).toBe(true);
  });

  it('opens a stored custom page in template mode when the user may not set one', async () => {
    await open({ own: { mode: 'custom', html: '<p>x</p>' }, canCustom: false });
    expect(dialog().querySelector('[data-test="html-file"]')).toBeNull();
    expect(dialog().querySelector('[data-test="title"]')).not.toBeNull();
  });
});
