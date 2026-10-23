import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { renderMarkdown } from '../src/markdown';

const show = (text: string) => mount(defineComponent({ render: () => h('div', renderMarkdown(text)) }));
const tags = (text: string) => show(text).findAll('*').map((e) => e.element.tagName.toLowerCase());

describe('renderMarkdown', () => {
  it('draws headings, paragraphs and a line break inside a paragraph', () => {
    const w = show('# Title\n\nfirst line\nsecond line\n\n### Small');
    expect(w.find('h4').text()).toBe('Title');
    expect(w.find('h5').text()).toBe('Small');
    expect(w.findAll('p')).toHaveLength(1);
    expect(w.find('p').html()).toContain('first line<br>second line');
  });

  it('draws bulleted and numbered lists, one list for consecutive items', () => {
    const w = show('- one\n- two\n\n1. first\n2. second\n3) third');
    expect(w.find('ul').findAll('li').map((l) => l.text())).toEqual(['one', 'two']);
    expect(w.find('ol').findAll('li').map((l) => l.text())).toEqual(['first', 'second', 'third']);
  });

  it('draws block quotes, nested a few levels at most', () => {
    const w = show('> quoted\n> still\n>\n> > deeper');
    expect(w.find('blockquote').text()).toContain('quoted');
    expect(w.findAll('blockquote')).toHaveLength(2);
    expect(show('>'.repeat(50) + ' x').findAll('blockquote').length).toBeLessThanOrEqual(4);
  });

  it('draws a fenced code block as text, markers and HTML untouched', () => {
    const w = show('```sh\n# not a heading\n**not bold** <b>x</b>\n```\nafter');
    expect(w.find('pre code').text()).toBe('# not a heading\n**not bold** <b>x</b>');
    expect(w.find('h4').exists()).toBe(false);
    expect(w.find('b').exists()).toBe(false);
    expect(w.find('p').text()).toBe('after');
  });

  it('keeps an unclosed fence as code to the end', () => {
    expect(show('```\na\nb').find('pre code').text()).toBe('a\nb');
  });

  it('draws code, bold and italic inline', () => {
    const w = show('a `code` and **bold** and *italic* and 2 * 3 * 4');
    expect(w.find('code').text()).toBe('code');
    expect(w.find('strong').text()).toBe('bold');
    expect(w.find('em').text()).toBe('italic');
    expect(w.find('p').text()).toBe('a code and bold and italic and 2 * 3 * 4');
  });

  it('shows a script and raw HTML as text and adds no element', () => {
    const w = show('<script>alert(1)</script>\n\n<b>x</b> <img src=x onerror=alert(1)>');
    expect(w.text()).toContain('<script>alert(1)</script>');
    expect(w.text()).toContain('<b>x</b>');
    expect(tags('<script>alert(1)</script>\n\n<b>x</b>')).toEqual(['div', 'p', 'p']);
  });

  it('keeps javascript:, data: and http: links as text', () => {
    for (const bad of ['[x](javascript:alert(1))', '[x](http://a)', '[x](data:text/html,hi)', '[x](HTTPS://a)']) {
      const w = show(`see ${bad} end`);
      expect(w.find('a').exists(), bad).toBe(false);
      expect(w.text(), bad).toContain(bad);
    }
  });

  it('makes an https link open elsewhere without the opener', () => {
    const a = show('[x](https://a)').find('a');
    expect(a.attributes()).toMatchObject({ href: 'https://a', rel: 'noopener', target: '_blank' });
    expect(a.text()).toBe('x');
  });

  it('joins the lines of a paragraph with spaces on request (release notes)', () => {
    const w = mount(defineComponent({ render: () => h('div', renderMarkdown('a\nb', { joinLines: true })) }));
    expect(w.find('p').text()).toBe('a b');
    expect(w.find('br').exists()).toBe(false);
  });

  // Review focus 1: hostile text draws as text, in linear time.
  it.each([
    ['4,000 asterisks', '*'.repeat(4000)],
    ['4,000 pairs of asterisks', '**a'.repeat(1333)],
    ['one long line', 'word '.repeat(20_000)],
    ['an unclosed bracket run', '[a](b'.repeat(800)],
    ['brackets', '['.repeat(4000)],
    ['backticks', '`'.repeat(4000)],
    ['nested quotes', '> '.repeat(2000)],
    ['dashes', '- '.repeat(2000)],
    ['hashes', '#'.repeat(4000)],
    ['spaces', `#${' '.repeat(100_000)}x`],
    ['mixed', '*`['.repeat(1300)],
  ])('draws %s within a time bound', (_name, text) => {
    const start = performance.now();
    expect(() => show(text)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
