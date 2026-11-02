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
});
