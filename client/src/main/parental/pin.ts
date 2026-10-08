// The parental PIN on the PC: checked here, so it works without NODUS. The skill sends only the
// scrypt hash; wrong attempts slow down (a 6-digit PIN is short, the pause is the real defence).
import { scrypt, timingSafeEqual } from "crypto";

export interface PinHash {
  hash: string;
  salt: string;
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export interface PinAttempts {
  /** times of wrong attempts in the window */
  failures: number[];
  lockedUntil: number;
}

const WINDOW_MS = 10 * 60_000;
const FREE_TRIES = 5;
const FIRST_PAUSE_MS = 30_000;
const MAX_PAUSE_MS = 30 * 60_000;

export const isPinHash = (value: unknown): value is PinHash => {
  const pin = value as PinHash | null;

  return Boolean(
    pin && typeof pin.hash === "string" && /^[0-9a-f]{16,256}$/.test(pin.hash) && typeof pin.salt === "string" && pin.salt.length >= 8 &&
      [pin.N, pin.r, pin.p, pin.keylen].every((number) => Number.isInteger(number) && number > 0) && pin.N <= 1 << 20,
  );
};

export function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  return new Promise((resolve) => {
    if (!/^\d{4,12}$/.test(pin)) {
      resolve(false);
      return;
    }
    scrypt(pin, stored.salt, stored.keylen, { N: stored.N, r: stored.r, p: stored.p, maxmem: 256 * stored.N * stored.r }, (error, key) => {
      if (error) {
        resolve(false);
        return;
      }

      const expected = Buffer.from(stored.hash, "hex");

      resolve(expected.length === key.length && timingSafeEqual(expected, key));
    });
  });
}

export const noAttempts = (): PinAttempts => ({ failures: [], lockedUntil: 0 });

/** Seconds to wait before the next try; 0 - may try now. */
export const pinWait = (attempts: PinAttempts, now: number): number => Math.max(0, Math.ceil((attempts.lockedUntil - now) / 1000));

/** A wrong PIN: after 5 in 10 minutes each next one doubles the pause, from 30 s. */
export function pinFailed(attempts: PinAttempts, now: number): PinAttempts {
  const failures = [...attempts.failures.filter((time) => now - time < WINDOW_MS), now];
  const over = failures.length - FREE_TRIES;
  const lockedUntil = over >= 0 ? now + Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** over) : attempts.lockedUntil;

  return { failures, lockedUntil };
}
