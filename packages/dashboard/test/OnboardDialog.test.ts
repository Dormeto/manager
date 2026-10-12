import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import OnboardDialog from '../src/components/OnboardDialog.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function openDialog() {
  const wrapper = mount(OnboardDialog, { props: { modelValue: false, title: 'shop.example.com', defaultName: 'shop' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
}
const input = (label: string) => [...document.querySelectorAll('.v-dialog .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input')!;
const onboardButton = () => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Onboard') as HTMLButtonElement;

describe('OnboardDialog', () => {
  it('sends the fallback instance types (R7b), none when empty', async () => {
    const wrapper = await openDialog();
    onboardButton().click();
    expect((wrapper.emitted('submit')![0]![0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty('fallbackInstanceTypes');
    const field = input('Fallback instance types');
    field.value = ' t3a.medium, m6i.large ';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    onboardButton().click();
    expect((wrapper.emitted('submit')![1]![0] as { settings: Record<string, unknown> }).settings.fallbackInstanceTypes).toEqual(['t3a.medium', 'm6i.large']);
    wrapper.unmount();
  });

  it('refuses a list that is not EC2 instance types, or more than 5', async () => {
    const wrapper = await openDialog();
    const field = input('Fallback instance types');
    for (const value of ['t3a medium', 't3.small, t3.medium, t3.large, t3a.small, t3a.medium, t3a.large']) {
      field.value = value;
      field.dispatchEvent(new Event('input'));
      await flushPromises();
      expect(onboardButton().disabled, value).toBe(true);
    }
    wrapper.unmount();
  });
});
