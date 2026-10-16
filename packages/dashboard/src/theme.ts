// The dashboard's themes, those of the website: the night by default, a cool light one for the day. The state colors are
// Vuetify's names (success: awake, info: asleep, warning: waking, error: failed), but napping's: a pale orange of its own,
// told apart from waking's orange, the same in the state chip, the history and the 7-day bar (user request).
type Theme = { dark?: boolean; colors: Record<string, string>; variables?: Record<string, string | number> };

export const THEMES: { light: Theme; dark: Theme } = {
  light: {
    colors: {
      primary: '#034b80', 'on-primary': '#ffffff', secondary: '#b04500', 'on-secondary': '#ffffff',
      background: '#f3f5f9', surface: '#ffffff', 'surface-variant': '#e8ecf3', 'on-surface-variant': '#334155',
      success: '#0f8a5f', info: '#3b5bdb', warning: '#c26a00', error: '#d93f3f', napping: '#d99a4e', 'on-napping': '#2b1903',
      sun: '#ff6900', moon: '#c9a85a', night: '#0e2446',
    },
    variables: { 'border-color': '#0b1220', 'border-opacity': 0.1, 'medium-emphasis-opacity': 0.68 },
  },
  dark: {
    dark: true,
    colors: {
      primary: '#8fc1ee', 'on-primary': '#05070d', secondary: '#ff9b55', 'on-secondary': '#05070d',
      background: '#05070d', surface: '#0d1422', 'surface-bright': '#141d30', 'surface-variant': '#1a2335', 'on-surface-variant': '#c9d3e3',
      success: '#3ecf8e', info: '#8fb4ff', warning: '#ffb547', error: '#ff6b6b', napping: '#efc794',
      sun: '#ff9b55', moon: '#f6e5b8', night: '#0e2446',
    },
    variables: { 'border-color': '#ffffff', 'border-opacity': 0.09, 'medium-emphasis-opacity': 0.66, 'high-emphasis-opacity': 0.94 },
  },
};
