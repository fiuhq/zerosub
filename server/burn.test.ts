import { describe, expect, it } from "vitest";
import type { Usage, UsageWindow } from "../shared/model";
import { BurnTracker, MAX_TURN_MS, MIN_TURN_MS, turnHorizon } from "./burn";

const T0 = Date.parse("2026-10-29T12:00:00Z");
const MIN = 60_000;
const RESET_5H = new Date(T0 + 4 * 3_600_000).toISOString();
const RESET_WEEK = new Date(T0 + 72 * 3_600_000).toISOString();

function reading(at: number, fiveHour: number, weekly: number, fiveReset = RESET_5H, patch: Partial<Usage> = {}): Usage {
  const windows: UsageWindow[] = [
    { id: "five_hour", label: "5-hour", usedPercent: fiveHour, resetsAt: fiveReset },
    { id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAt: RESET_WEEK },
  ];
  return { fetchedAt: new Date(at).toISOString(), windows, error: null, cached: false, resets: null, ...patch };
}

describe("BurnTracker", () => {
  it("projects each window at its recent pace", () => {
    const burn = new BurnTracker();
    burn.note("a", reading(T0, 50, 40));
    const latest = reading(T0 + 10 * MIN, 70, 41);
    burn.note("a", latest);
    // 20 points in 10 minutes is 2 a minute: 15 more minutes takes the 5-hour window to 100 (capped).
    const ahead = burn.project("a", latest, 15 * MIN, T0 + 10 * MIN);
    expect(ahead?.windows.map((w) => w.usedPercent)).toEqual([100, 42.5]);
  });

  it("starts a new climb after a reset, and ignores readings it can't trust", () => {
    const burn = new BurnTracker();
    burn.note("a", reading(T0, 90, 40));
    burn.note("a", reading(T0 + 5 * MIN, 99, 40, RESET_5H, { cached: true }));
    const fresh = new Date(T0 + 10 * MIN + 5 * 3_600_000).toISOString();
    const latest = reading(T0 + 10 * MIN, 5, 40, fresh);
    burn.note("a", latest);
    expect(burn.project("a", latest, 30 * MIN, T0 + 10 * MIN)?.windows[0]?.usedPercent).toBe(5);
  });

  it("forgets readings older than its span and needs two minutes between readings", () => {
    const burn = new BurnTracker();
    burn.note("a", reading(T0, 10, 40));
    const late = reading(T0 + 40 * MIN, 60, 40);
    burn.note("a", late);
    expect(burn.project("a", late, 30 * MIN, T0 + 40 * MIN)?.windows[0]?.usedPercent).toBe(60);
    const quick = new BurnTracker();
    quick.note("a", reading(T0, 50, 40));
    const next = reading(T0 + MIN, 60, 40);
    quick.note("a", next);
    expect(quick.project("a", next, 30 * MIN, T0 + MIN)?.windows[0]?.usedPercent).toBe(60);
  });

  it("leaves a window that resets within the horizon as it is", () => {
    const burn = new BurnTracker();
    const soon = new Date(T0 + 20 * MIN).toISOString();
    burn.note("a", reading(T0, 50, 40, soon));
    const latest = reading(T0 + 10 * MIN, 70, 40, soon);
    burn.note("a", latest);
    expect(burn.project("a", latest, 15 * MIN, T0 + 10 * MIN)?.windows[0]?.usedPercent).toBe(70);
  });

  it("never projects usage going down", () => {
    const burn = new BurnTracker();
    burn.note("a", reading(T0, 70, 40));
    const latest = reading(T0 + 10 * MIN, 60, 40);
    burn.note("a", latest);
    expect(burn.project("a", latest, 15 * MIN, T0 + 10 * MIN)?.windows[0]?.usedPercent).toBe(60);
  });
});

describe("turnHorizon", () => {
  it("expects the next turn to last as long as the last one, within bounds", () => {
    expect(turnHorizon(T0, T0 + 12 * MIN)).toBe(12 * MIN);
    expect(turnHorizon(T0, T0 + 5_000)).toBe(MIN_TURN_MS);
    expect(turnHorizon(T0, T0 + 5 * 3_600_000)).toBe(MAX_TURN_MS);
    expect(turnHorizon(undefined, T0)).toBe(MIN_TURN_MS);
  });
});
