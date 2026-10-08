// Parental control time, the pure part: how much the PC and games were used today, what is left,
// when to warn and when to block. No electron here: the clock and the inputs come from outside,
// so vitest checks every rule (weekday/weekend, idle, extensions, unlocks, midnight).

export type LimitKind = "pc" | "games";

export interface DayLimits {
  /** minutes a day; null - no limit, 0 - not at all */
  pcMin: number | null;
  gamesMin: number | null;
}

export interface ParentalRules {
  limits: { weekday: DayLimits; weekend: DayLimits };
  extend: Record<LimitKind, { minutes: number; times: number }>;
  unlockMinutes: number;
  games: { add: string[]; remove: string[] };
}

export interface Usage {
  /** local date of the PC, YYYY-MM-DD */
  day: string;
  pcSec: number;
  gameSec: number;
  /** "+N minutes" presses today */
  extended: Record<LimitKind, number>;
}

export interface TickInput {
  /** wall clock: the day and the weekend */
  now: number;
  /** monotonic clock: elapsed time, immune to clock changes */
  mono: number;
  /** the session is unlocked and awake */
  unlocked: boolean;
  /** seconds without keyboard and mouse */
  idleSec: number;
  /** a fullscreen window is in front: a film counts even without input */
  fullscreen: boolean;
  /** a game window runs */
  gameRunning: boolean;
}

export interface KindStatus {
  /** today's limit with the extensions; null - no limit */
  limitSec: number | null;
  usedSec: number;
  leftSec: number | null;
  /** 10 minutes or less left */
  near: boolean;
  reached: boolean;
  extendsLeft: number;
  extendMinutes: number;
}

export interface ParentalStatus {
  day: string;
  weekend: boolean;
  /** the limits are lifted (panel, voice, PIN) */
  granted: boolean;
  grantUntil: number | null;
  pc: KindStatus;
  games: KindStatus;
}

export const WARN_SEC = 10 * 60;
export const IDLE_SEC = 5 * 60;
/** A longer gap between ticks (sleep, a frozen process) is not counted. */
const MAX_STEP_MS = 5000;

const pad = (value: number) => String(value).padStart(2, "0");

export const dayKey = (time: number): string => {
  const date = new Date(time);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Saturday and Sunday on the PC's clock. */
export const isWeekend = (time: number): boolean => [0, 6].includes(new Date(time).getDay());

export const emptyUsage = (now: number): Usage => ({ day: dayKey(now), pcSec: 0, gameSec: 0, extended: { pc: 0, games: 0 } });

export class ParentalClock {
  usage: Usage;
  grantUntil: number | null;
  private lastMono: number | null = null;

  constructor(
    public rules: ParentalRules,
    usage: Usage | null,
    grantUntil: number | null,
    now: number,
  ) {
    this.usage = usage && usage.day === dayKey(now) ? structuredClone(usage) : emptyUsage(now);
    this.grantUntil = grantUntil;
  }

  granted(now: number): boolean {
    return this.grantUntil !== null && this.grantUntil > now;
  }

  /** Count the time since the previous tick and tell what is left. */
  tick(input: TickInput): ParentalStatus {
    if (this.usage.day !== dayKey(input.now)) this.usage = emptyUsage(input.now);

    const step = this.lastMono === null ? 0 : input.mono - this.lastMono;
    const seconds = step > 0 && step <= MAX_STEP_MS ? step / 1000 : 0;

    this.lastMono = input.mono;

    // the parent at the PC (granted) does not use the child's time
    if (seconds && input.unlocked && !this.granted(input.now)) {
      if (input.idleSec < IDLE_SEC || input.fullscreen || input.gameRunning) this.usage.pcSec += seconds;
      if (input.gameRunning) this.usage.gameSec += seconds;
    }

    return this.status(input.now);
  }

  status(now: number): ParentalStatus {
    const weekend = isWeekend(now);
    const limits = weekend ? this.rules.limits.weekend : this.rules.limits.weekday;
    const granted = this.granted(now);
    const kind = (name: LimitKind, baseMin: number | null, used: number): KindStatus => {
      const extend = this.rules.extend[name];
      const extended = this.usage.extended[name];
      const limitSec = baseMin === null ? null : (baseMin + extended * extend.minutes) * 60;
      const leftSec = limitSec === null ? null : Math.max(0, Math.ceil(limitSec - used));

      return {
        limitSec,
        usedSec: Math.floor(used),
        leftSec,
        near: !granted && leftSec !== null && leftSec > 0 && leftSec <= WARN_SEC,
        reached: !granted && leftSec !== null && leftSec <= 0,
        extendsLeft: limitSec === null ? 0 : Math.max(0, extend.times - extended),
        extendMinutes: extend.minutes,
      };
    };

    return {
      day: this.usage.day,
      weekend,
      granted,
      grantUntil: granted ? this.grantUntil : null,
      pc: kind("pc", limits.pcMin, this.usage.pcSec),
      games: kind("games", limits.gamesMin, this.usage.gameSec),
    };
  }

  /** "+N minutes": only while there is a limit and presses are left today. */
  extend(kind: LimitKind, now: number): boolean {
    if (this.status(now)[kind].extendsLeft <= 0) return false;
    this.usage.extended[kind] += 1;
    return true;
  }

  reset(now: number): void {
    this.usage = emptyUsage(now);
  }

  /** Counters NODUS kept (the local file may be gone): the larger ones win on the same day. */
  merge(server: Usage | null): void {
    if (!server || server.day !== this.usage.day) return;
    this.usage.pcSec = Math.max(this.usage.pcSec, server.pcSec);
    this.usage.gameSec = Math.max(this.usage.gameSec, server.gameSec);
    this.usage.extended.pc = Math.max(this.usage.extended.pc, server.extended?.pc ?? 0);
    this.usage.extended.games = Math.max(this.usage.extended.games, server.extended?.games ?? 0);
  }
}
