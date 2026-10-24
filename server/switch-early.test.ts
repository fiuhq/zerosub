import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Usage, UsageWindow } from "../shared/model";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { chooseAccount, hasRoom, nearlyFull } from "./routing";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, emptyState, type StoredAccount, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

const LINES = { short: 80, long: 95 };
const NOW = Date.parse("2026-10-24T12:00:00Z");
const MAIN = MAIN_ACCOUNT_ID.claude;
const SPARE = "claude-spare";
const AGENT = "agent-1";

const inHours = (hours: number, from = NOW) => new Date(from + hours * 3_600_000).toISOString();

function windows(fiveHour: number, weekly: number, from = NOW): UsageWindow[] {
  return [
    { id: "five_hour", label: "5-hour", usedPercent: fiveHour, resetsAt: inHours(2, from) },
    { id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAt: inHours(72, from) },
  ];
}

function reading(fiveHour: number, weekly: number, patch: Partial<Usage> = {}): Usage {
  return { fetchedAt: new Date(NOW - 60_000).toISOString(), windows: windows(fiveHour, weekly), error: null, cached: false, resets: null, ...patch };
}

describe("nearlyFull", () => {
  it("holds a 5-hour window to its own line and a weekly one to the higher weekly line", () => {
    expect(nearlyFull(reading(80, 10), LINES, NOW).map((w) => w.id)).toEqual(["five_hour"]);
    expect(nearlyFull(reading(10, 94), LINES, NOW)).toEqual([]);
    expect(nearlyFull(reading(10, 95), LINES, NOW).map((w) => w.id)).toEqual(["seven_day"]);
  });

  it("never acts on a reading it can't trust", () => {
    expect(nearlyFull(reading(99, 99, { cached: true }), LINES, NOW)).toEqual([]);
    expect(nearlyFull(reading(99, 99, { error: "Usage request failed (HTTP 500)" }), LINES, NOW)).toEqual([]);
    expect(nearlyFull(reading(99, 99, { fetchedAt: new Date(NOW - 11 * 60_000).toISOString() }), LINES, NOW)).toEqual([]);
    expect(nearlyFull(null, LINES, NOW)).toEqual([]);
  });

  it("leaves a full window that refills in the next few minutes", () => {
    const soon = reading(90, 10);
    soon.windows[0] = { ...soon.windows[0]!, resetsAt: new Date(NOW + 5 * 60_000).toISOString() };
    expect(nearlyFull(soon, LINES, NOW)).toEqual([]);
  });

  it("is off for a kind of window whose line is 100", () => {
    expect(nearlyFull(reading(99, 99), { short: 100, long: 100 }, NOW)).toEqual([]);
    expect(nearlyFull(reading(100, 100), { short: 100, long: 100 }, NOW)).toEqual([]);
    expect(nearlyFull(reading(100, 95), { short: 100, long: 95 }, NOW).map((w) => w.id)).toEqual(["seven_day"]);
  });
});

describe("hasRoom", () => {
  it("needs a margin below every line, so a move is worth its lost prompt cache", () => {
    expect(hasRoom(reading(69, 84), LINES, NOW)).toBe(true);
    expect(hasRoom(reading(70, 10), LINES, NOW)).toBe(false);
    expect(hasRoom(reading(10, 85), LINES, NOW)).toBe(false);
  });

  it("ignores a kind of window whose line is 100 when picking where to move", () => {
    expect(hasRoom(reading(95, 10), { short: 100, long: 95 }, NOW)).toBe(true);
    expect(hasRoom(reading(100, 10), { short: 100, long: 95 }, NOW)).toBe(true);
  });

  it("counts an unknown or stale reading as no room", () => {
    expect(hasRoom(null, LINES, NOW)).toBe(false);
    expect(hasRoom(reading(0, 0, { cached: true }), LINES, NOW)).toBe(false);
  });
});

function account(id: string, kind: "main" | "managed" = "managed"): StoredAccount {
  return {
    id,
    family: "claude",
    label: id,
    autoLabel: false,
    kind,
    home: kind === "main" ? null : `/homes/${id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
  };
}

describe("new agents", () => {
  const route = (usage: Record<string, Usage>, patch: Partial<StoredState> = {}, early: typeof LINES | null = LINES) =>
    chooseAccount(
      { ...emptyState(), accounts: [account(MAIN, "main"), account(SPARE)], ...patch },
      { agentId: AGENT, family: "claude", reason: "create", now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: (id) => usage[id], early },
    );

  it("start on an account with room instead of a nearly full default, and stay there", () => {
    const decision = route({ [MAIN]: reading(85, 40), [SPARE]: reading(20, 30) });
    expect(decision?.account.id).toBe(SPARE);
    expect(decision?.skipped).toMatchObject({ why: "nearly_full" });
    expect(decision?.bind).toMatchObject({ accountId: SPARE, source: "auto" });
  });

  it("stay on the default when no other account has room to spare", () => {
    expect(route({ [MAIN]: reading(85, 40), [SPARE]: reading(75, 30) })?.account.id).toBe(MAIN);
  });

  it("stay on the default with switch early off", () => {
    expect(route({ [MAIN]: reading(85, 40), [SPARE]: reading(20, 30) }, {}, null)?.account.id).toBe(MAIN);
  });

  it("keep an account chosen for them", () => {
    const bindings = { [AGENT]: { accountId: MAIN, source: "user" as const, at: new Date(NOW).toISOString() } };
    expect(route({ [MAIN]: reading(85, 40), [SPARE]: reading(20, 30) }, { bindings })?.account.id).toBe(MAIN);
  });

  it("don't move a resumed agent: that's the turn-end check's job", () => {
    const decision = chooseAccount(
      { ...emptyState(), accounts: [account(MAIN, "main"), account(SPARE)] },
      { agentId: AGENT, family: "claude", reason: "resume", now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: (id) => ({ [MAIN]: reading(85, 40), [SPARE]: reading(20, 30) })[id], early: LINES },
    );
    expect(decision?.account.id).toBe(MAIN);
  });
});

// ------------------------------------------------------------------ after a turn

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-early-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** A Claude adapter whose usage reading for each account comes from `levels`, read when asked. */
function adapter(levels: Record<string, [fiveHour: number, weekly: number]>, reads: string[]): FamilyAdapter {
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async (home: string | null): Promise<UsageRead> => {
      const id = home ? home.split("/").pop()! : MAIN;
      reads.push(id);
      const [fiveHour, weekly] = levels[id] ?? [0, 0];
      return { fetchedAt: new Date().toISOString(), windows: windows(fiveHour, weekly, Date.now()), error: null, cached: false, resets: null };
    },
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
    environmentWarning: () => null,
  } as unknown as FamilyAdapter;
}

async function setUp(levels: Record<string, [number, number]>, state: Partial<StoredState> = {}, prefs: Record<string, unknown> = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, { accounts: [account(MAIN, "main"), account(SPARE)], defaults: { claude: MAIN, codex: null }, sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: new Date().toISOString() } }, ...state }),
  );
  const reads: string[] = [];
  const reopened: string[] = [];
  const notes: Array<{ reason: string; from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const agent = { id: AGENT, provider: "claude", status: "idle", archivedAt: null };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => undefined,
        timeline: { append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data), refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const context = { paseo } as never;
  const reopener = {
    reopen: async (id: string) => {
      reopened.push(id);
      await service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const }) };
  const claude = adapter(levels, reads);
  const service = new Service({ claude, codex: claude }, store, families as unknown as FamilyResolver, reopener as unknown as Reopener);
  service.setPreferences(preferences.schema.parse(prefs));
  // Readings for the other accounts, as the background upkeep would have taken them.
  for (const id of Object.keys(levels)) await service.refreshUsage(id, true);
  reads.length = 0;
  const turnEnds = () =>
    service.onTurnEnded({ agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never, context);
  return { service, store, reads, reopened, notes, turnEnds };
}

describe("switch early after a turn", () => {
  it("moves the agent to an account with room, reading usage after the turn first", async () => {
    const levels: Record<string, [number, number]> = { [MAIN]: [70, 40], [SPARE]: [10, 20] };
    const { store, reads, reopened, notes, turnEnds } = await setUp(levels);
    levels[MAIN] = [84, 41]; // the turn just used it
    await turnEnds();
    expect(reads[0]).toBe(MAIN);
    expect(reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: SPARE, source: "auto" });
    expect(state.sessions[AGENT]?.accountId).toBe(SPARE);
    expect(notes.at(-1)).toMatchObject({ reason: "early", from: MAIN, to: SPARE, outcome: "switched", detail: "at 84% of its 5-hour limit" });
  });

  it("stays when the account is below its line", async () => {
    const { reopened, turnEnds } = await setUp({ [MAIN]: [79, 94], [SPARE]: [0, 0] });
    await turnEnds();
    expect(reopened).toEqual([]);
  });

  it("stays when no other account has room to spare", async () => {
    const { reopened, notes, turnEnds } = await setUp({ [MAIN]: [90, 40], [SPARE]: [72, 20] });
    await turnEnds();
    expect(reopened).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("leaves an account the user chose for the agent", async () => {
    const bindings = { [AGENT]: { accountId: MAIN, source: "user" as const, at: new Date().toISOString() } };
    const { reopened, turnEnds } = await setUp({ [MAIN]: [90, 40], [SPARE]: [0, 0] }, { bindings });
    await turnEnds();
    expect(reopened).toEqual([]);
  });

  it("does nothing when switching is off", async () => {
    const { reopened, turnEnds } = await setUp({ [MAIN]: [90, 40], [SPARE]: [0, 0] }, {}, { autoSwitch: false });
    await turnEnds();
    expect(reopened).toEqual([]);
  });

  it("moves back once the first account has room again and the second fills up", async () => {
    const levels: Record<string, [number, number]> = { [MAIN]: [85, 40], [SPARE]: [10, 20] };
    const { store, reopened, turnEnds } = await setUp(levels);
    await turnEnds();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(SPARE);
    levels[MAIN] = [5, 41]; // its 5-hour window refilled
    levels[SPARE] = [83, 25];
    await turnEnds();
    expect(reopened).toEqual([AGENT, AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
  });
});
