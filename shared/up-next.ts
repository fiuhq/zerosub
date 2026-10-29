import type { Usage, UsageWindow } from "./model";

/**
 * Up next: the order agents are given accounts in. Quota a window doesn't use before it resets is
 * lost, so an account whose spare long-window quota runs out soonest goes first. An account at a
 * switch line goes last, and one with no reading sits between the two.
 */
export interface UpNextLines {
  short: number;
  long: number;
}

/** The switch-early defaults, used where the caller has no lines of its own. */
export const UP_NEXT_LINES: UpNextLines = { short: 80, long: 95 };

/** A window with no reset time is assumed to refill within a week. */
const UNKNOWN_RESET_HOURS = 168;

export interface UpNextRank {
  /** 0: room on every window. 1: no reading. 2: a window is at or over its line. */
  tier: 0 | 1 | 2;
  /** Percent of the binding window that goes unused per hour from now until it resets, to one decimal. */
  perHour: number;
  /** The window `perHour` was read from. */
  limit: UsageWindow | null;
}

export function isLongWindow(window: UsageWindow): boolean {
  return /week|seven|month|day/i.test(`${window.id} ${window.label}`);
}

function hoursLeft(window: UsageWindow, now: number): number {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return UNKNOWN_RESET_HOURS;
  return Math.max((at - now) / 3_600_000, 1 / 60);
}

export function upNextRank(usage: Usage | null | undefined, now: number, lines: UpNextLines = UP_NEXT_LINES): UpNextRank {
  const windows = usage?.windows ?? [];
  if (windows.length === 0) return { tier: 1, perHour: 0, limit: null };
  const cramped = windows.some((window) => window.usedPercent >= (isLongWindow(window) ? lines.long : lines.short));
  // The long windows are the budget; an account with none (a 5-hour-only plan) is judged on what it has.
  const long = windows.filter(isLongWindow);
  let binding: UsageWindow | null = null;
  let perHour = Infinity;
  for (const window of long.length > 0 ? long : windows) {
    const rate = Math.max(0, 100 - window.usedPercent) / hoursLeft(window, now);
    if (rate < perHour) {
      perHour = rate;
      binding = window;
    }
  }
  return { tier: cramped ? 2 : 0, perHour: Math.round(perHour * 10) / 10, limit: binding };
}

/** Negative when `a` goes before `b`; 0 when Up next can't tell them apart. */
export function compareUpNext(a: UpNextRank, b: UpNextRank): number {
  return a.tier - b.tier || b.perHour - a.perHour;
}
