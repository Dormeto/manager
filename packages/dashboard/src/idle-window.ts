// A workload's idle window advice (R10), read once for the cards that show it (the Idle window card, the requests
// heatmap): while a read runs, the other card waits for the same one.
import { api } from './api';
import type { IdleWindowAdvice } from './types';

const reading = new Map<string, Promise<IdleWindowAdvice>>();

export function readIdleWindow(router: string, id: string): Promise<IdleWindowAdvice> {
  const path = `/workloads/${encodeURIComponent(router)}/${encodeURIComponent(id)}/idle-window`;
  let read = reading.get(path);
  if (!read) {
    read = api<IdleWindowAdvice>(path).finally(() => reading.delete(path));
    reading.set(path, read);
  }
  return read;
}
