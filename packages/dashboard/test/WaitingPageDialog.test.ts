import { afterEach, describe, expect, it } from 'vitest';
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
type Props = { level?: 'workload' | 'router' | 'organization'; own?: StoredPage | null; canCustom?: boolean; favicon?: string | null; error?: string; saving?: boolean };
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
async function choose(name: string, file: File) {
  const input = pick(name).querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
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
});
