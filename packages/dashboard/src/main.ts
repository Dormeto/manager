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
import { THEMES, initialTheme } from './theme';

const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    // The user's choice, else the system's.
    defaultTheme: initialTheme(),
    themes: THEMES,
  },
  defaults: {
    VCard: { rounded: 'xl', variant: 'flat', border: true },
    VBtn: { rounded: 'lg', class: 'text-none' },
    VChip: { size: 'small' },
    VTextField: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VSelect: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VAutocomplete: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VTextarea: { variant: 'outlined', rounded: 'lg' },
    VDialog: { scrim: 'rgba(3, 5, 11, 0.7)' },
    VTooltip: { contentClass: 'dm-tooltip' },
    VProgressLinear: { color: 'secondary', height: 2 },
  },
});

initAuth(await loadConfig());
createApp(App).use(createPinia()).use(vuetify).use(router).mount('#app');
