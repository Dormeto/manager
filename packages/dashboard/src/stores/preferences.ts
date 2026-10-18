import { defineStore } from 'pinia';
import { api } from '../api';

// Dashboard preferences of the signed-in user, saved by the API (DynamoDB).
export const usePreferences = defineStore('preferences', {
  state: () => ({ refreshSeconds: 10, dismissedUpdate: '', loaded: false, error: '' }),
  actions: {
    async load() {
      if (this.loaded) return;
      try {
        const prefs = await api<{ refreshSeconds: number; dismissedUpdate?: string }>('/preferences');
        this.refreshSeconds = prefs.refreshSeconds;
        this.dismissedUpdate = prefs.dismissedUpdate ?? '';
      } catch (err) {
        this.error = (err as Error).message;
      } finally {
        this.loaded = true;
      }
    },
    async setRefresh(seconds: number) {
      const previous = this.refreshSeconds;
      this.refreshSeconds = seconds;
      try {
        await api('/preferences', { method: 'PUT', body: JSON.stringify({ refreshSeconds: seconds }) });
        this.error = '';
      } catch (err) {
        this.refreshSeconds = previous;
        this.error = (err as Error).message;
      }
    },
    // The update notice of a version, hidden from now on (a newer version shows it again).
    async dismissUpdate(version: string) {
      const previous = this.dismissedUpdate;
      this.dismissedUpdate = version;
      try {
        await api('/preferences', { method: 'PUT', body: JSON.stringify({ dismissedUpdate: version }) });
        this.error = '';
      } catch (err) {
        this.dismissedUpdate = previous;
        this.error = (err as Error).message;
      }
    },
  },
});
