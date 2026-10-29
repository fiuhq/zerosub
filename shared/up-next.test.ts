import { describe, expect, it } from "vitest";
import type { Usage, UsageWindow } from "./model";
import { compareUpNext, upNextRank } from "./up-next";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function usage(...windows: UsageWindow[]): Usage {
  return { fetchedAt: new Date(NOW).toISOString(), windows, error: null, cached: false, resets: null };
}
const fiveHour = (usedPercent: number, hours = 4): UsageWindow => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: inHours(hours) });
const weekly = (usedPercent: number, hours: number): UsageWindow => ({ id: "seven_day", label: "Weekly", usedPercent, resetsAt: inHours(hours) });

describe("upNextRank", () => {
  it("puts quota that resets soonest first, even when the account is more used", () => {
    // 97% of a week left that resets in 32h beats 89% left that resets in 94h.
    const soon = upNextRank(usage(fiveHour(18), weekly(3, 32)), NOW);
    const later = upNextRank(usage(fiveHour(0), weekly(11, 94)), NOW);
    expect(soon.perHour).toBe(3);
    expect(later.perHour).toBe(0.9);
    expect(compareUpNext(soon, later)).toBeLessThan(0);
  });

  it("judges the busiest long window, not a quiet per-model one", () => {
    const rank = upNextRank(usage(weekly(63, 37), { id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 0, resetsAt: inHours(37) }), NOW);
    expect(rank.limit?.label).toBe("Weekly");
    expect(rank.perHour).toBe(1);
  });

  it("sends an account at a switch line last, after one with no reading", () => {
    const cramped = upNextRank(usage(fiveHour(85), weekly(0, 2)), NOW);
    const unknown = upNextRank(null, NOW);
    const roomy = upNextRank(usage(fiveHour(10), weekly(50, 100)), NOW);
    expect([cramped, unknown, roomy].sort(compareUpNext)).toEqual([roomy, unknown, cramped]);
  });

  it("uses the caller's lines", () => {
    expect(upNextRank(usage(fiveHour(75), weekly(0, 50)), NOW, { short: 70, long: 95 }).tier).toBe(2);
    expect(upNextRank(usage(fiveHour(75), weekly(0, 50)), NOW).tier).toBe(0);
  });

  it("ranks a plan with only a 5-hour window by what it has left", () => {
    expect(compareUpNext(upNextRank(usage(fiveHour(20)), NOW), upNextRank(usage(fiveHour(60)), NOW))).toBeLessThan(0);
  });
});
