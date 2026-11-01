// What the Schedule dialog draws of the overlap rules: small samples on a time axis, each with the real windows it stands for
// (test/occurrences-parity.test.ts holds them to the router's check). A bar's from and to are shares of its axis, 0 to 100.
import type { ScheduleWindow } from './schedule';

export interface SampleBar { label: string; kind: 'awake' | 'nap'; from: number; to: number }
export interface OverlapSample {
  id: string;
  allowed: boolean;
  title: string;
  note: string;
  axis: string[];
  bars: SampleBar[];
  // One list per workload: the rule compares the windows of one workload only.
  schedules: ScheduleWindow[][];
}

const DAILY = { pattern: 'daily' } as const;
const HOURS = ['08:00', '12:00', '16:00', '20:00'];
// A close-up of an hour, 11:30 to 12:30, where 10 minutes show.
const CLOSE_UP = ['11:30', '12:00', '12:30'];
const minute = (m: number): number => (m / 60) * 100;
// Hours on the axis from 08:00 to 20:00, as a share of it.
const at = (hour: number): number => ((hour - 8) / 12) * 100;
const bar = (label: string, kind: 'awake' | 'nap', from: number, to: number): SampleBar => ({ label, kind, from: at(from), to: at(to) });
const awake = (start: string, end: string, more: Partial<ScheduleWindow> = {}): ScheduleWindow => ({ kind: 'awake', start, end, repeat: DAILY, ...more });
const nap = (start: string, end: string, more: Partial<ScheduleWindow> = {}): ScheduleWindow => ({ kind: 'nap', start, end, repeat: DAILY, ...more });

export const OVERLAP_SAMPLES: OverlapSample[] = [
  {
    id: 'awake-awake', allowed: true, title: 'Awake and awake', note: 'Allowed: they count as one longer window.', axis: HOURS,
    bars: [bar('Awake', 'awake', 8, 14), bar('Awake', 'awake', 12, 18)],
    schedules: [[awake('08:00', '14:00'), awake('12:00', '18:00')]],
  },
  {
    id: 'nap-nap', allowed: true, title: 'Nap and nap', note: 'Allowed, the same. If any active one says never wake, requests do not wake it.', axis: HOURS,
    bars: [bar('Nap', 'nap', 8, 14), bar('Nap', 'nap', 12, 18)],
    schedules: [[nap('08:00', '14:00'), nap('12:00', '18:00')]],
  },
  {
    id: 'awake-nap', allowed: false, title: 'Awake and nap', note: 'Refused on Save, naming both windows and the first time they meet.', axis: HOURS,
    bars: [bar('Awake', 'awake', 8, 14), bar('Nap', 'nap', 12, 18)],
    schedules: [[awake('08:00', '14:00'), nap('12:00', '18:00')]],
  },
  {
    id: 'touching', allowed: true, title: 'Touching', note: 'Allowed: awake to 12:00, nap from 12:00 do not overlap.', axis: HOURS,
    bars: [bar('Awake', 'awake', 8, 12), bar('Nap', 'nap', 12, 20)],
    schedules: [[awake('08:00', '12:00'), nap('12:00', '20:00')]],
  },
  {
    id: 'joined', allowed: true, title: 'Joined', note: '10 minutes apart: nothing wakes it in the gap. One kind only, up to the value set (15 minutes by default, 0 never).', axis: CLOSE_UP,
    bars: [{ label: 'Nap', kind: 'nap', from: 0, to: minute(25) }, { label: 'Nap', kind: 'nap', from: minute(35), to: 100 }, { label: 'Reads', kind: 'nap', from: 0, to: 100 }],
    schedules: [[nap('08:00', '11:55'), nap('12:05', '18:00')]],
  },
  {
    id: 'dates', allowed: true, title: 'Different dates', note: 'Allowed: awake until 30 Jun, nap from 1 Jul, at the same hours.', axis: ['June', '1 July', 'August'],
    bars: [{ label: 'Awake', kind: 'awake', from: 0, to: 48 }, { label: 'Nap', kind: 'nap', from: 52, to: 100 }],
    schedules: [[awake('08:00', '18:00', { until: '2027-06-30' }), nap('08:00', '18:00', { from: '2027-07-01' })]],
  },
  {
    id: 'workloads', allowed: true, title: 'Two workloads', note: 'Allowed: they never conflict, even drawn together on the calendar.', axis: HOURS,
    bars: [bar('Shop', 'awake', 8, 14), bar('Blog', 'nap', 12, 18)],
    schedules: [[awake('08:00', '14:00')], [nap('12:00', '18:00')]],
  },
];
