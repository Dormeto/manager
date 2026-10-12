// The dashboard's themes. The state colors are Vuetify's, but napping's: a pale orange of its own, told apart from waking's
// orange, the same in the state chip, the history and the 7-day bar (user request).
type Theme = { dark?: boolean; colors: Record<string, string> };

export const THEMES: { light: Theme; dark: Theme } = {
  light: { colors: { primary: '#3546c4', secondary: '#8f5200', background: '#f6f5f2', surface: '#ffffff', napping: '#f4c58c' } },
  dark: { dark: true, colors: { primary: '#8b98ff', secondary: '#f5b14c', background: '#0f1220', surface: '#1a2036', napping: '#efc794' } },
};
