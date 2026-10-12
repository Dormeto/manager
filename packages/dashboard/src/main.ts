import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';
import 'vuetify/styles';
import './style.css';
import App from './App.vue';
import { loadConfig } from './config';
import { initAuth } from './auth';
import { router } from './router';

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
let theme = prefersDark ? 'dark' : 'light';
try {
  theme = window.localStorage.getItem('dmt-theme') ?? theme;
} catch {
  // Storage unavailable: system preference.
}

const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: theme,
    themes: {
      light: { colors: { primary: '#3546c4', secondary: '#8f5200', background: '#f6f5f2', surface: '#ffffff' } },
      dark: { dark: true, colors: { primary: '#8b98ff', secondary: '#f5b14c', background: '#0f1220', surface: '#1a2036' } },
    },
  },
  defaults: { VCard: { rounded: 'lg', variant: 'flat', border: true }, VBtn: { rounded: 'lg' }, VChip: { size: 'small' } },
});

initAuth(await loadConfig());
createApp(App).use(createPinia()).use(vuetify).use(router).mount('#app');
