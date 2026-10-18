import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReleaseNotes from '../src/components/ReleaseNotes.vue';
import { withoutOwnHeading } from '../src/update';

const show = (notes: string) => mount(ReleaseNotes, { props: { notes } });

describe('ReleaseNotes', () => {
  it('shows a script as text and adds no element', () => {
    const w = show('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(w.text()).toContain('<script>alert(1)</script>');
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.findAll('*').map((e) => e.element.tagName)).toEqual(['DIV', 'P', 'P']);
  });

  it('shows a javascript: link as its source text', () => {
    const w = show('see [click](javascript:alert(1)) and [rel](http://example.com)');
    expect(w.find('a').exists()).toBe(false);
    expect(w.text()).toContain('[click](javascript:alert(1))');
    expect(w.text()).toContain('[rel](http://example.com)');
  });

  it('makes an https link open elsewhere without the opener', () => {
    const a = show('read [the procedure](https://dormeto.com/organization-access.html).').find('a');
    expect(a.text()).toBe('the procedure');
    expect(a.attributes()).toMatchObject({ href: 'https://dormeto.com/organization-access.html', rel: 'noopener', target: '_blank' });
  });

  it('draws headings, one list for consecutive items, joined paragraph lines, code and bold', () => {
    const w = show('## Added\n- one `code`\n- two **bold**\n  wrapped\n\nfirst line\nsecond line\n\n### Fixed\n- three');
    expect(w.findAll('h4')).toHaveLength(1);
    expect(w.find('h5').text()).toBe('Fixed');
    const lists = w.findAll('ul');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.findAll('li').map((l) => l.text())).toEqual(['one code', 'two bold wrapped']);
    expect(w.find('li code').text()).toBe('code');
    expect(w.find('strong').text()).toBe('bold');
    expect(w.find('p').text()).toBe('first line second line');
  });

  it('drops the notes\' own heading line, the page shows the version', () => {
    expect(withoutOwnHeading('## 0.13.0 — 2026-10-15\n\n- a', '0.13.0')).toBe('- a');
    expect(withoutOwnHeading('## Added\n- a', '0.13.0')).toBe('## Added\n- a');
  });
});
