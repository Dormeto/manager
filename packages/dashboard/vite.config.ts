import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

// Local development: `npm run dev` proxies /api and /config.json to the deployed dev dashboard.
const remote = process.env.DASHBOARD_URL ?? 'https://app.dev.dormeto.com';

export default defineConfig(({ command, mode }) => {
  // The demo mode (VITE_MOCK, npm run dev:mock) is for development only: a build refuses it, in any mode, from the
  // environment or an .env file of the directory it runs in or of the dashboard's (a build leaves src/mock out anyway).
  const dirs = new Set([process.cwd(), fileURLToPath(new URL('.', import.meta.url))]);
  if (command === 'build' && [...dirs].some((dir) => loadEnv(mode, dir, 'VITE_').VITE_MOCK)) {
    throw new Error('VITE_MOCK is set: the demo mode (npm run dev:mock) never goes into a build; unset it, in the environment and the .env files');
  }
  return {
    plugins: [vue(), vuetify({ autoImport: true })],
    server: { proxy: { '/api': { target: remote, changeOrigin: true }, '/config.json': { target: remote, changeOrigin: true } } },
    build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
    test: { environment: 'jsdom', server: { deps: { inline: ['vuetify'] } } },
  };
});
