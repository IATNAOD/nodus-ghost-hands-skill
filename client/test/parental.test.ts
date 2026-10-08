import { scryptSync, randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { ParentalClock, dayKey, isWeekend, WARN_SEC, type ParentalRules, type TickInput } from "../src/main/parental/accounting";
import { noAttempts, pinFailed, pinWait, verifyPin, isPinHash } from "../src/main/parental/pin";
import { sanitizeParental } from "@skill/protocol.js";
import { PARENTAL_IPC } from "../src/shared/types";

// Thursday 2026-10-08 10:00 local time, and Saturday
const THURSDAY = new Date(2026, 9, 8, 10, 0, 0).getTime();
const SATURDAY = new Date(2026, 9, 10, 10, 0, 0).getTime();

const rules = (patch: Partial<ParentalRules> = {}): ParentalRules => ({
  ...(sanitizeParental({}) as ParentalRules),
  limits: { weekday: { pcMin: 60, gamesMin: 30 }, weekend: { pcMin: 120, gamesMin: null } },
  ...patch,
});

/** Run `seconds` of one-second ticks with the same inputs. */
const run = (clock: ParentalClock, start: number, seconds: number, input: Partial<TickInput> = {}) => {
  let status = clock.tick({ now: start, mono: start, unlocked: true, idleSec: 0, fullscreen: false, gameRunning: false, ...input });

  for (let i = 1; i <= seconds; i++) status = clock.tick({ now: start + i * 1000, mono: start + i * 1000, unlocked: true, idleSec: 0, fullscreen: false, gameRunning: false, ...input });

  return status;
};

describe("parental time", () => {
  it("knows the day and the weekend from the PC's clock", () => {
    expect(dayKey(THURSDAY)).toBe("2026-10-08");
    expect(isWeekend(THURSDAY)).toBe(false);
    expect(isWeekend(SATURDAY)).toBe(true);
  });

  it("counts PC time while someone is there, game time while a game runs", () => {
    const clock = new ParentalClock(rules(), null, null, THURSDAY);

    run(clock, THURSDAY, 60);
    expect(clock.usage.pcSec).toBe(60);
    expect(clock.usage.gameSec).toBe(0);

    run(clock, THURSDAY + 100_000, 30, { gameRunning: true, idleSec: 900 });
    expect(clock.usage.gameSec).toBe(30);
    expect(clock.usage.pcSec).toBe(90);

    // idle without a game or a film, or a locked session: not counted
    run(clock, THURSDAY + 200_000, 30, { idleSec: 900 });
    run(clock, THURSDAY + 300_000, 30, { unlocked: false });
    expect(clock.usage.pcSec).toBe(90);

    // a film in full screen counts without input
    run(clock, THURSDAY + 400_000, 10, { idleSec: 900, fullscreen: true });
    expect(clock.usage.pcSec).toBe(100);
  });

  it("does not count a sleep gap or a clock jump", () => {
    const clock = new ParentalClock(rules(), null, null, THURSDAY);

    clock.tick({ now: THURSDAY, mono: 0, unlocked: true, idleSec: 0, fullscreen: false, gameRunning: false });
    clock.tick({ now: THURSDAY + 3600_000, mono: 3600_000, unlocked: true, idleSec: 0, fullscreen: false, gameRunning: false });
    expect(clock.usage.pcSec).toBe(0);
  });

  it("warns 10 minutes before, blocks at the limit; weekend limits differ", () => {
    const clock = new ParentalClock(rules(), { day: "2026-10-08", pcSec: 0, gameSec: 30 * 60 - WARN_SEC + 1, extended: { pc: 0, games: 0 } }, null, THURSDAY);

    expect(clock.status(THURSDAY).games.near).toBe(true);
    expect(clock.status(THURSDAY).games.reached).toBe(false);

    const reached = run(clock, THURSDAY, WARN_SEC, { gameRunning: true });

    expect(reached.games.reached).toBe(true);
    expect(reached.pc.reached).toBe(false);

    const weekend = new ParentalClock(rules(), null, null, SATURDAY);

    expect(weekend.status(SATURDAY).games.limitSec).toBe(null);
    expect(weekend.status(SATURDAY).pc.limitSec).toBe(120 * 60);
  });

  it("a zero limit blocks at once; +N minutes only within the presses left", () => {
    const clock = new ParentalClock(rules({ limits: { weekday: { pcMin: 60, gamesMin: 0 }, weekend: { pcMin: null, gamesMin: null } } }), null, null, THURSDAY);

    expect(clock.status(THURSDAY).games.reached).toBe(true);
    expect(clock.extend("games", THURSDAY)).toBe(true);
    expect(clock.status(THURSDAY).games.leftSec).toBe(15 * 60);
    expect(clock.extend("games", THURSDAY)).toBe(true);
    expect(clock.extend("games", THURSDAY)).toBe(false);
    expect(clock.status(THURSDAY).games.extendsLeft).toBe(0);

    // no limit - nothing to extend
    const weekend = new ParentalClock(rules(), null, null, SATURDAY);

    expect(weekend.extend("games", SATURDAY)).toBe(false);
  });

  it("an unlock stops counting and blocking; a new day starts from zero", () => {
    const clock = new ParentalClock(rules(), { day: "2026-10-08", pcSec: 3600, gameSec: 3600, extended: { pc: 0, games: 0 } }, THURSDAY + 3600_000, THURSDAY);

    expect(clock.status(THURSDAY).pc.reached).toBe(false);
    run(clock, THURSDAY, 30);
    expect(clock.usage.pcSec).toBe(3600);
    expect(clock.status(THURSDAY + 3700_000).pc.reached).toBe(true);

    const friday = new Date(2026, 9, 9, 0, 0, 5).getTime();
    const status = clock.tick({ now: friday, mono: friday, unlocked: true, idleSec: 0, fullscreen: false, gameRunning: false });

    expect(status.day).toBe("2026-10-09");
    expect(clock.usage).toEqual({ day: "2026-10-09", pcSec: 0, gameSec: 0, extended: { pc: 0, games: 0 } });
  });

  it("takes the larger counters NODUS kept for the same day", () => {
    const clock = new ParentalClock(rules(), null, null, THURSDAY);

    clock.merge({ day: "2026-10-08", pcSec: 500, gameSec: 100, extended: { pc: 1, games: 0 } });
    clock.merge({ day: "2026-10-07", pcSec: 9000, gameSec: 9000, extended: { pc: 2, games: 2 } });
    expect(clock.usage).toEqual({ day: "2026-10-08", pcSec: 500, gameSec: 100, extended: { pc: 1, games: 0 } });
  });
});

describe("parental PIN", () => {
  const stored = (pin: string) => {
    const salt = randomBytes(16).toString("hex");

    return { hash: scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex"), salt, N: 16384, r: 8, p: 1, keylen: 32 };
  };

  it("checks the PIN against the hash from the skill", async () => {
    const hash = stored("583920");

    expect(isPinHash(hash)).toBe(true);
    expect(isPinHash({ hash: "zz", salt: "", N: 1, r: 1, p: 1, keylen: 1 })).toBe(false);
    expect(await verifyPin("583920", hash)).toBe(true);
    expect(await verifyPin("583921", hash)).toBe(false);
    expect(await verifyPin("abc", hash)).toBe(false);
  });

  it("five wrong tries are free, then each one doubles the pause", () => {
    let attempts = noAttempts();

    for (let i = 0; i < 4; i++) attempts = pinFailed(attempts, 1000 + i);
    expect(pinWait(attempts, 2000)).toBe(0);

    attempts = pinFailed(attempts, 2000);
    expect(pinWait(attempts, 2000)).toBe(30);
    attempts = pinFailed(attempts, 40_000);
    expect(pinWait(attempts, 40_000)).toBe(60);
    // old failures leave the 10-minute window
    expect(pinWait(pinFailed(attempts, 40_000 + 11 * 60_000), 40_000 + 11 * 60_000)).toBe(0);
  });
});

describe("parental preload", () => {
  const source = readFileSync(path.join(__dirname, "../src/preload/parental.ts"), "utf8");

  // a value imported by both preloads goes to a shared chunk, and a sandboxed preload cannot
  // require it: the main window would lose window.gh
  it("imports only types from the shared code", () => {
    expect(source).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"\.\.\/shared/m);
  });

  it("uses the channels of PARENTAL_IPC", () => {
    expect(source).toContain(`invoke: "${PARENTAL_IPC.invoke}"`);
    expect(source).toContain(`state: "${PARENTAL_IPC.state}"`);
  });
});
