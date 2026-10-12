import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

// Local development: `npm run dev` proxies /api and /config.json to the deployed dev dashboard.
const remote = process.env.DASHBOARD_URL ?? 'https://app.dev.dormeto.com';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  server: { proxy: { '/api': { target: remote, changeOrigin: true }, '/config.json': { target: remote, changeOrigin: true } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: 'jsdom', server: { deps: { inline: ['vuetify'] } } },
});
