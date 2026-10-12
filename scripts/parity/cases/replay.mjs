// The replay of idle windows (fleet src/idle.ts, R10): the cases of fleet test/idle.test.ts, and the edge cases of the
// spec's §6 (nothing priced, Spot, the business-hours baseline, the estimate's own call).
import { canonical } from '../recorded.mjs';

export const name = 'replay';

const FROM = '2026-09-26T00:00:00.000Z';
const DAYS = 14;
const TO = new Date(Date.parse(FROM) + DAYS * 86_400_000).toISOString();
const END = DAYS * 1440;
const at = (minute) => new Date(Date.parse(FROM) + minute * 60_000).toISOString();
const requests = (minutes) => ({ from: FROM, to: TO, minutes });
const daily = requests(Array.from({ length: DAYS }, (_, d) => [600 + d * 1440, 1]));
const T3 = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };
// An item the router could not describe, as it says one (fleet src/prices.ts): never priced.
const ODD = { kind: 'unknown', backend: 'ecs:x', reason: 'denied' };
const ALWAYS = { kind: 'always' };
const PARIS = { kind: 'business-hours', timeZone: 'Europe/Paris' };
const NINE = [5, 10, 15, 20, 30, 45, 60, 90, 120];

const replayCase = (title, minutes, windows, { wakeSeconds = 0, startAsleep = true, checkMinutes = 5 } = {}) => ({
  name: `replayIdle: ${title}`, input: { function: 'replayIdle', requests: requests(minutes), windows, checkMinutes, wakeSeconds, startAsleep },
});
const recommendCase = (title, wakes, extra = []) => ({
  name: `recommendWindow: ${title}`, input: { function: 'recommendWindow', rows: [...NINE.map((minutes, i) => ({ minutes, wakes: wakes[i] })), ...extra] },
});

export function cases(now) {
  const advice = (title, over = {}) => ({
    name: `idleWindowAdvice: ${title}`,
    input: {
      function: 'idleWindowAdvice', requests: daily, current: 15, checkMinutes: 5, wakeMs: 30_000, startAsleep: false, actualWakes: 14, actualFrom: FROM,
      stopped: [T3], prices: [{ item: T3, usd: 0.0456 }], baseline: ALWAYS, wakerTargetGroup: true, now, running: null, ...over,
    },
  });
  const every6h = Array.from({ length: END / 360 }, (_, k) => [k * 360, 1]);
  return [
    { name: 'replayIdle: one request a day, awake at the start, a wake of 60 s', input: { function: 'replayIdle', requests: daily, windows: [15], checkMinutes: 5, wakeSeconds: 60, startAsleep: false } },
    replayCase('a request every 10 minutes for an hour, at 5 and 15 minutes', [600, 610, 620, 630, 640, 650].map((m) => [m, 3]), [5, 15]),
    replayCase('a silence just under the window keeps it awake, one of the window wakes it again', [[600, 1], [614, 1], [630, 1]], [15]),
    replayCase('naps only at a check: a window of 7 minutes', [[600, 1]], [7]),
    replayCase('requests during a wake are activity, not wakes', [[600, 1], [601, 2], [602, 1]], [15], { wakeSeconds: 180 }),
    replayCase('stays awake a full window after a wake', [[600, 1]], [15], { wakeSeconds: 600 }),
    replayCase('asleep from the start without any request', [], [15]),
    replayCase('a request starting at the check that naps comes after the nap', [[15, 1]], [15], { startAsleep: false }),
    replayCase('a window of a day over a request every 6 hours: never asleep', every6h, [1440], { startAsleep: false }),
    replayCase('a request in the last minute wakes it', [[END - 1, 1]], [15]),
    replayCase('minutes out of order or repeated are added up', [[650, 1], [600, 2], [600, 3], [610, 1]], [15]),
    replayCase('every window tried with a current one of 25, checked every hour', [[600, 1], [700, 2], [2100, 1], [9000, 4]], [...NINE.slice(0, 4), 25, ...NINE.slice(4)], { checkMinutes: 60, wakeSeconds: 45 }),
    recommendCase('the shortest window avoiding 90% of the wakes the longest avoids', [40, 30, 20, 12, 11, 10, 10, 9, 9]),
    recommendCase('the same wakes for every window: the shortest', [7, 7, 7, 7, 7, 7, 7, 7, 7]),
    recommendCase('no wake at all: the shortest', [0, 0, 0, 0, 0, 0, 0, 0, 0]),
    recommendCase('wakes rising again for a longer window: the first under the threshold', [40, 30, 12, 20, 11, 10, 10, 9, 9]),
    recommendCase('only the nine windows are candidates, not a current 25 or 1,440', [40, 30, 20, 12, 11, 10, 10, 9, 9], [{ minutes: 25, wakes: 11 }, { minutes: 1440, wakes: 0 }]),
    { name: 'recommendWindow: no row: the shortest of the nine', input: { function: 'recommendWindow', rows: [] } },
    ...[15, 25, 1440].map((current) => ({ name: `windowsFor: a current window of ${current}`, input: { function: 'windowsFor', current } })),
    ...['rate(5 minutes)', 'rate(1 minute)', 'rate(1 hour)', 'rate(2 hours)', 'cron(0/5 * * * ? *)', null].map((schedule) => ({
      name: `checkMinutesOf: ${schedule ?? 'no schedule'}`, input: { function: 'checkMinutesOf', schedule },
    })),
    advice('each window priced, asleep hours, wakes and wait; the knee; the real wakes'),
    advice('within the business-hours baseline', { baseline: PARIS }),
    advice('an item without a price: nothing priced, never a partial figure', { stopped: [T3, ODD], prices: [{ item: T3, usd: 0.0456 }, { item: ODD, usd: null }] }),
    advice('no nap described yet: nothing priced', { stopped: null, prices: [] }),
    advice('a backend running 08:00 to 20:00 UTC: saves only while it ran', { running: Array.from({ length: DAYS }, (_, d) => ({ from: at(d * 1440 + 480), to: at(d * 1440 + 1200) })) }),
    advice('a backend measured running all the time', { running: [{ from: FROM, to: TO }] }),
    advice('a backend measured never running: nothing saved', { running: [] }),
    advice('no wake measured yet: the wait unknown', { wakeMs: null }),
    advice('clearly more wakes replayed than real ones: noisy', { actualWakes: 9 }),
    advice('a few more wakes replayed than real ones: not noisy', { actualWakes: 10 }),
    advice('4 replayed wakes for 2 real ones: not noisy (at least 3 more)', { requests: requests([600, 2040, 3480, 4920].map((m) => [m, 1])), actualWakes: 2 }),
    advice('compared over the time the history knows: onboarded on day 5', { actualFrom: at(5 * 1440), actualWakes: 9 }),
    advice('a history that knows none of the period: no comparison', { actualFrom: null, actualWakes: 2 }),
    advice('a current window of a day is shown, never recommended', { current: 1440 }),
    advice('Spot capacity and pods on nodes, in Paris business hours', {
      stopped: [{ kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux', spot: true }, { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } }],
      prices: [{ item: { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux', spot: true }, usd: 0.038 }, { item: { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } }, usd: 0.02772 }],
      baseline: PARIS,
    }),
    advice('as the estimate calls it: a 60-minute window, no history, a Fargate service on Fargate and Fargate Spot', {
      current: 60, wakeMs: 60_000, actualWakes: 0, actualFrom: null, wakerTargetGroup: false,
      requests: requests(Array.from({ length: DAYS }, (_, d) => [[540 + d * 1440, 2], [780 + d * 1440, 1], [1020 + d * 1440, 5]]).flat()),
      stopped: [{ kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'x86_64', os: 'Linux' }, { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 3, arch: 'x86_64', os: 'Linux', spot: true }],
      prices: [{ item: { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'x86_64', os: 'Linux' }, usd: 0.0123425 }, { item: { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 3, arch: 'x86_64', os: 'Linux', spot: true }, usd: 0.01110825 }],
    }),
  ];
}

// The price of each item, given with the case: Go builds the same callback from input.prices.
export const pricesOf = (prices) => async (item) => {
  const found = prices.find((p) => canonical(p.item) === canonical(item));
  if (!found) throw new Error(`no price given for ${canonical(item)}`);
  return found.usd;
};

export async function run(product, input) {
  switch (input.function) {
    case 'replayIdle': return product.replayIdle(input);
    case 'recommendWindow': return product.recommendWindow(input.rows);
    case 'windowsFor': return product.windowsFor(input.current);
    case 'checkMinutesOf': return product.checkMinutesOf(input.schedule);
    case 'idleWindowAdvice': {
      const { function: _, prices, now, ...rest } = input;
      return product.idleWindowAdvice({ ...rest, hourly: pricesOf(prices), now: Date.parse(now) });
    }
    default: throw new Error(`unknown function ${input.function}`);
  }
}

export const readme = `The fleet's idle window replay (\`packages/fleet/src/idle.ts\`, Go \`internal/replay\`). \`input.function\` names
the function:

- \`idleWindowAdvice\` (Go \`replay.Advice\`): \`input\` holds its argument's fields as Node takes them — \`requests\`
  (\`{from, to, minutes: [[minute, count]]}\`, minutes from \`from\`), \`current\`, \`checkMinutes\`, \`wakeMs\` (or null),
  \`startAsleep\`, \`actualWakes\`, \`actualFrom\` (or null), \`stopped\` (the items, or null), \`baseline\`
  (\`{kind: "always"}\` or \`{kind: "business-hours", timeZone}\`), \`wakerTargetGroup\`, \`running\` (periods, or null) —
  with \`now\` an ISO date (Node takes milliseconds) and \`prices\` in place of the \`hourly\` callback: \`[{item, usd}]\`,
  the hourly price of each item it is asked (\`usd\` null: no price); an item is found by equal JSON (sorted keys), one
  missing is an error. Output: the \`IdleWindowAdvice\` (\`computedAt\` is \`now\`).
- \`replayIdle\` (Go \`replay.Replay\`): \`{requests, windows, checkMinutes, wakeSeconds, startAsleep}\`. Output: one
  \`{minutes, asleep: [{from, to}], wakes, wokeAt}\` per window.
- \`recommendWindow\` (Go \`replay.Recommend\`): \`{rows: [{minutes, wakes}]}\`. Output: the window, in minutes.
- \`windowsFor\` (Go \`replay.Windows\`): \`{current}\`. Output: the windows tried.
- \`checkMinutesOf\` (Go \`replay.CheckMinutes\`): \`{schedule}\` (a string or null). Output: minutes.

No recorded answers.`;
