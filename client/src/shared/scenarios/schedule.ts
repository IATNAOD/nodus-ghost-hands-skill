// The schedule of scenarios: "at 08:30 on weekdays". Local time of the PC. Pure.

export interface ScheduleRule {
  time: string;
  /** 0 - Sunday ... 6 - Saturday */
  days: number[];
  missed: "skip" | "once";
}

const DAY_MS = 24 * 3600_000;
/** a tick a bit late (the event loop, a slow minute timer) still counts as on time */
export const ON_TIME_MS = 90_000;
/** a run missed while the PC slept or the client was off is caught up within a day */
export const CATCH_UP_MS = DAY_MS;

const parse = (time: string): [number, number] => {
  const [h, m] = time.split(":").map(Number);
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
};

/** The moments of a rule in (from, to], at most a week of them. */
export function occurrences(rule: ScheduleRule, from: number, to: number): number[] {
  const [hour, minute] = parse(rule.time);
  const result: number[] = [];
  const start = new Date(from);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  for (let i = 0; i < 9 && day.getTime() <= to; i++, day.setDate(day.getDate() + 1)) {
    if (!rule.days.includes(day.getDay())) continue;

    // setHours, not +ms: a day with a clock change has 23 or 25 hours
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime();
    if (at > from && at <= to) result.push(at);
  }
  return result;
}

/** The next moment after `from` (for the UI), or null when no day is chosen. */
export function nextFire(rule: ScheduleRule, from: number): number | null {
  return rule.days.length ? (occurrences(rule, from, from + 8 * DAY_MS)[0] ?? null) : null;
}

/**
 * Should a rule fire now? `lastTick` - when the schedule was checked last, `lastFired` - the
 * moment it fired for last (no double run after a restart).
 * @returns the moment to fire for, or null
 */
export function due(rule: ScheduleRule, lastTick: number, now: number, lastFired: number | null): number | null {
  const from = Math.max(lastTick, now - CATCH_UP_MS, lastFired ?? 0);
  const moments = occurrences(rule, from, now);
  const latest = moments.at(-1);

  if (latest === undefined) return null;
  if (now - latest <= ON_TIME_MS) return latest;
  return rule.missed === "once" ? latest : null;
}
