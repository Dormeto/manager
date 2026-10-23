import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DescriptionCard from '../src/components/DescriptionCard.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const DESCRIPTION = { text: '# Shop\n\n- front\n- [docs](https://wiki.example.com/shop)', by: 'fab@example.com', at: new Date(Date.now() - 3 * 3_600_000).toISOString() };
type Props = { description: typeof DESCRIPTION | null | undefined; canEdit: boolean; saving?: boolean; error?: string };
const mounted: ReturnType<typeof mount>[] = [];
function show(props: Props) {
  const w = mount(DescriptionCard, { props, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  mounted.push(w);
  return w;
}
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const dialog = () => document.body.querySelector('[data-test="description-dialog"]');
// A closed dialog leaves its content in the document until its transition ends: ask the dialog.
const isOpen = (w: ReturnType<typeof mount>) => w.findComponent({ name: 'VDialog' }).props('modelValue');
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const field = () => document.body.querySelector('[data-test="description-text"] textarea') as HTMLTextAreaElement;
async function type(text: string) {
  field().value = text;
  field().dispatchEvent(new Event('input'));
  await nextTick();
}

describe('DescriptionCard', () => {
  it('draws the text, who wrote it and when', () => {
    const w = show({ description: DESCRIPTION, canEdit: false });
    expect(w.find('h4').text()).toBe('Shop');
    expect(w.find('a').attributes()).toMatchObject({ href: 'https://wiki.example.com/shop', rel: 'noopener' });
    expect(w.find('[data-test="description-by"]').text()).toBe('— fab@example.com, 3 h ago');
  });

  it('says "No description" and hides the buttons from whoever cannot write', () => {
    const w = show({ description: null, canEdit: false });
    expect(w.text()).toContain('No description');
    expect(w.text()).not.toContain('Add a description');
    expect(w.find('[data-test="edit-description"]').exists()).toBe(false);
    const other = show({ description: DESCRIPTION, canEdit: false });
    expect(other.find('[data-test="edit-description"]').exists()).toBe(false);
  });

  it('offers "Add a description" without one and "Edit" with one, to whoever can write', () => {
    expect(show({ description: null, canEdit: true }).get('[data-test="edit-description"]').text()).toBe('Add a description');
    expect(show({ description: DESCRIPTION, canEdit: true }).get('[data-test="edit-description"]').text()).toBe('Edit');
  });

  it('shows nothing at all when the description could not be read, whoever the user is', () => {
    const w = show({ description: undefined, canEdit: true });
    expect(w.text()).toBe('');
    expect(w.find('[data-test="description-card"]').exists()).toBe(false);
  });

  it('opens the dialog on the text, counts code points out of 4,000, and previews the drawn text', async () => {
    const w = show({ description: DESCRIPTION, canEdit: true });
    await w.get('[data-test="edit-description"]').trigger('click');
    await flushPromises();
    expect(field().value).toBe(DESCRIPTION.text);
    expect(dialog()!.textContent).toContain(`${[...DESCRIPTION.text].length} / 4,000`);
    await type('héllo 😀');
    expect(dialog()!.textContent).toContain('7 / 4,000');
    button('Preview')!.click();
    await flushPromises();
    await type('x');
    expect(dialog()!.querySelector('.dm-md')).not.toBeNull();
    button('Write')!.click();
    await flushPromises();
    await type('# Drawn\n\n**bold**');
    button('Preview')!.click();
    await flushPromises();
    expect(dialog()!.querySelector('.dm-md h4')!.textContent).toBe('Drawn');
    expect(dialog()!.querySelector('.dm-md strong')!.textContent).toBe('bold');
  });

  it('sends the text on Save and Clear only exists with a description', async () => {
    const w = show({ description: DESCRIPTION, canEdit: true });
    await w.get('[data-test="edit-description"]').trigger('click');
    await flushPromises();
    await type('  new text  ');
    button('Save')!.click();
    await flushPromises();
    expect(w.emitted('save')).toEqual([['  new text  '.trim()]]);
    expect(button('Clear')).toBeDefined();
    button('Clear')!.click();
    await flushPromises();
    expect(w.emitted('clear')).toHaveLength(1);
  });

  it('has no Clear without a description', async () => {
    const w = show({ description: null, canEdit: true });
    await w.get('[data-test="edit-description"]').trigger('click');
    await flushPromises();
    expect(button('Save')).toBeDefined();
    expect(button('Clear')).toBeUndefined();
  });

  it('refuses over 4,000 characters locally and keeps the dialog open with the API\'s message', async () => {
    const w = show({ description: null, canEdit: true });
    await w.get('[data-test="edit-description"]').trigger('click');
    await flushPromises();
    await type('a'.repeat(4001));
    expect(dialog()!.textContent).toContain('4001 / 4,000');
    expect(button('Save')!.disabled).toBe(true);
    await type('ok');
    expect(button('Save')!.disabled).toBe(false);
    button('Save')!.click();
    await w.setProps({ saving: true });
    await w.setProps({ saving: false, error: 'text must be at most 4000 characters' });
    await flushPromises();
    expect(dialog()!.textContent).toContain('text must be at most 4000 characters');
    // The refusal leaves the dialog open; a success (no error) closes it.
    await w.setProps({ saving: true, error: '' });
    await w.setProps({ saving: false });
    await flushPromises();
    expect(isOpen(w)).toBe(false);
  });

  it('Cancel closes without sending', async () => {
    const w = show({ description: DESCRIPTION, canEdit: true });
    await w.get('[data-test="edit-description"]').trigger('click');
    await flushPromises();
    button('Cancel')!.click();
    await flushPromises();
    expect(w.emitted('save')).toBeUndefined();
    expect(isOpen(w)).toBe(false);
  });
});
