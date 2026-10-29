import { describe, expect, it } from "vitest";
import type { AccountView, Usage, UsageWindow } from "./model";
import { compareUpNext, upNextOrder, upNextRank } from "./up-next";

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

function view(id: string, weeklyUsed: number, resetsInHours: number, patch: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "claude",
    label: id,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: usage(fiveHour(0), weekly(weeklyUsed, resetsInHours)),
    agentCount: 0,
    home: null,
    projects: [],
    ...patch,
  };
}

describe("upNextOrder", () => {
  // The worked example: the default has 89% of a week left resetting in 94h, the spare 97% in 32h.
  const team = view("claude-team", 11, 94, { isDefault: true });
  const max = view("claude-max", 3, 32);
  const roles = (rows: ReturnType<typeof upNextOrder>) => rows.map(({ account, role }) => [account.id, role]);

  it("sends new agents and switches to the top when new agents are spread", () => {
    expect(roles(upNextOrder([team, max], NOW, undefined, true))).toEqual([
      ["claude-max", "here"],
      ["claude-team", null],
    ]);
  });

  it("starts new agents on the default when they aren't spread, and switches to the top", () => {
    expect(roles(upNextOrder([team, max], NOW, undefined, false))).toEqual([
      ["claude-max", "switch"],
      ["claude-team", "start"],
    ]);
  });

  it("lists an account kept for a project after the shared ones and never on top", () => {
    const kept = view("claude-kept", 0, 2, { projects: [{ projectId: "p1", name: "Gaz" }] });
    const out = view("claude-out", 0, 1, { status: "limited" });
    expect(roles(upNextOrder([out, kept, team, max], NOW, undefined, true))).toEqual([
      ["claude-max", "here"],
      ["claude-team", null],
      ["claude-kept", "project"],
      ["claude-out", null],
    ]);
  });
});
