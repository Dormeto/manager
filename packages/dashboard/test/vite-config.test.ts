// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';

// The user, 2026-11-02: in the demo, Operations and Users could not be clicked. The Vuetify components the plugin imports as it
// compiles a view are not seen by the dev server's first scan: a view's first visit found new ones, the server rebuilt its
// dependencies and reloaded, and the view's code could not be fetched meanwhile.
describe('dev server', () => {
  it('pre-bundles every Vuetify component and directive at its start, so no view\'s first visit rebuilds them', async () => {
    const config = await resolveConfig({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'silent' }, 'serve', 'development');
    expect(config.optimizeDeps.include).toEqual(expect.arrayContaining(['vuetify/components/*', 'vuetify/directives/*']));
  });

  // The demo answers in the browser: a request typed in its page (a fetch of /api/…) must not reach the dev manager.
  it('proxies /api and /config.json to the dev dashboard, but not in the demo mode (VITE_MOCK=1), where nothing reaches the real API', async () => {
    const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const before = process.env.VITE_MOCK;
    try {
      delete process.env.VITE_MOCK;
      const live = await resolveConfig({ configFile, logLevel: 'silent' }, 'serve', 'development');
      expect(Object.keys(live.server.proxy ?? {}).sort()).toEqual(['/api', '/config.json']);
      process.env.VITE_MOCK = '1';
      const demo = await resolveConfig({ configFile, logLevel: 'silent' }, 'serve', 'development');
      expect(demo.server.proxy ?? {}).toEqual({});
    } finally {
      if (before === undefined) delete process.env.VITE_MOCK;
      else process.env.VITE_MOCK = before;
    }
  });
});
