import type { Usage, UsageWindow } from "../shared/model";

/** How far back the climb of a window is measured. */
export const BURN_SPAN_MS = 30 * 60_000;
/** Readings closer together than this say too little about a climb. */
const MIN_SPAN_MS = 2 * 60_000;
/** A turn's length counts between these bounds when projecting the next one. */
export const MIN_TURN_MS = 60_000;
export const MAX_TURN_MS = 60 * 60_000;

interface Sample {
  at: number;
  windows: UsageWindow[];
}

/**
 * Switch early decides after a turn, but a busy account (many agents, long turns) can climb from
 * under its line to 100% before the agent's next turn ends. The burn tracker keeps each account's
 * recent live readings, so a decision can rest on where a window is heading, not only where it is.
 */
export class BurnTracker {
  private readonly samples = new Map<string, Sample[]>();

  /** Records a live reading. Cached, failed and empty readings say nothing about the climb. */
  note(accountId: string, usage: Usage): void {
    if (usage.cached || usage.error || usage.windows.length === 0) return;
    const at = Date.parse(usage.fetchedAt);
    if (!Number.isFinite(at)) return;
    const kept = (this.samples.get(accountId) ?? []).filter((sample) => sample.at < at && at - sample.at <= BURN_SPAN_MS);
    kept.push({ at, windows: usage.windows });
    this.samples.set(accountId, kept);
  }

  /** Percent per minute a window has been climbing, or 0 when there's no telling. */
  climb(accountId: string, window: UsageWindow, now: number): number {
    // Recent live readings of the same window period: a reset in between starts a new climb.
    const readings = (this.samples.get(accountId) ?? []).flatMap((sample) => {
      const same = now - sample.at <= BURN_SPAN_MS ? sample.windows.find((other) => samePeriod(other, window)) : undefined;
      return same ? [{ at: sample.at, usedPercent: same.usedPercent }] : [];
    });
    const first = readings[0];
    const latest = readings.at(-1);
    if (!first || !latest || latest.at - first.at < MIN_SPAN_MS) return 0;
    return Math.max(0, (latest.usedPercent - first.usedPercent) / ((latest.at - first.at) / 60_000));
  }

  /**
   * The reading as it would stand `horizonMs` from now if each window keeps climbing at its recent
   * pace. A window that resets within the horizon refills, so it is left as it is.
   */
  project(accountId: string, usage: Usage | null | undefined, horizonMs: number, now: number): Usage | null | undefined {
    if (!usage || horizonMs <= 0) return usage;
    return {
      ...usage,
      windows: usage.windows.map((window) => {
        const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        if (Number.isFinite(resets) && resets <= now + horizonMs) return window;
        const ahead = this.climb(accountId, window, now) * (horizonMs / 60_000);
        return ahead > 0 ? { ...window, usedPercent: Math.min(100, window.usedPercent + ahead) } : window;
      }),
    };
  }
}

/** Windows of one period: the same window, resetting at the same time (give or take a minute). */
function samePeriod(a: UsageWindow, b: UsageWindow): boolean {
  if (a.id !== b.id) return false;
  if (!a.resetsAt || !b.resetsAt) return a.resetsAt === b.resetsAt;
  return Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= 60_000;
}

/** How long the next turn is expected to take: as long as the last one, within bounds. */
export function turnHorizon(startedAt: number | undefined, endedAt: number): number {
  if (startedAt === undefined || !(endedAt > startedAt)) return MIN_TURN_MS;
  return Math.min(MAX_TURN_MS, Math.max(MIN_TURN_MS, endedAt - startedAt));
}
