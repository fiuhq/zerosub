import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import { earlyLines, launchAccount, settledAccount, shellExports } from "./launch";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-10-29T04:30:00Z");
const prefs = preferences.schema.parse({});

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    auth: "subscription",
    home: `/homes/${partial.id}`,
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
    ...partial,
  };
}

function usage(percent: number): Usage {
  return { fetchedAt: "2026-10-29T04:29:00Z", windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }], error: null, cached: false, resets: null, credits: null };
}

const state = (accounts: StoredAccount[], patch: Partial<StoredState> = {}): StoredState => ({ ...emptyState(), accounts, ...patch });

describe("launchAccount", () => {
  it("follows the default while it has room", () => {
    const s = state([account({ id: "main" }), account({ id: "spare" })], { defaults: { claude: "main" } });
    expect(launchAccount(s, new Map([["main", usage(10)], ["spare", usage(5)]]), { ...prefs, balanceNewAgents: false }, "claude", NOW)?.id).toBe("main");
  });

  it("moves off a limited default to the account with room, as a new agent's routing does", () => {
    const s = state([account({ id: "main", limitedUntil: "2026-10-29T05:00:00Z" }), account({ id: "spare" })], { defaults: { claude: "main" } });
    expect(launchAccount(s, new Map([["main", usage(100)], ["spare", usage(18)]]), prefs, "claude", NOW)?.id).toBe("spare");
  });

  it("skips a nearly full default at switch early's line, and keeps it when switching is off", () => {
    const s = state([account({ id: "main" }), account({ id: "spare" })], { defaults: { claude: "main" } });
    const readings = new Map([["main", usage(90)], ["spare", usage(20)]]);
    const noBalance = { ...prefs, balanceNewAgents: false };
    expect(launchAccount(s, readings, noBalance, "claude", NOW)?.id).toBe("spare");
    expect(launchAccount(s, readings, { ...noBalance, autoSwitch: false }, "claude", NOW)?.id).toBe("main");
  });

  it("answers null when ZeroSub has no account of the family", () => {
    expect(launchAccount(state([]), new Map(), prefs, "claude", NOW)).toBeNull();
  });
});

describe("settledAccount", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "zerosub-launch-"));
    dirs.push(dir);
    return dir;
  };

  it("waits out a move on record and launches on the home the fresh read names", async () => {
    const root = scratch();
    const from = join(root, "homes", "claude-a");
    const to = root;
    const moving = state([account({ id: "claude-a", home: from })], { moves: { "claude-a": { from, to, at: "2026-11-17T00:00:00Z" } } });
    const reads = [moving, state([account({ id: "claude-a", home: to })])];
    let pauses = 0;
    const settled = await settledAccount(moving, "claude-a", async () => reads.shift()!, { pause: async () => void (pauses += 1) });
    expect(settled.home).toBe(to);
    expect(pauses).toBe(2);
  });

  it("launches at once on a home that is there, and on the CLI login, which has none", async () => {
    const home = scratch();
    const read = () => Promise.reject(new Error("read again"));
    expect((await settledAccount(state([account({ id: "claude-a", home })]), "claude-a", read)).home).toBe(home);
    expect((await settledAccount(state([account({ id: "claude-main", kind: "main", home: null })]), "claude-main", read)).home).toBeNull();
  });

  it("stops after its reads, naming the account and the move, when the move never finishes", async () => {
    const s = state([account({ id: "claude-a", label: "Work", home: "/gone/claude-a" })], {
      moves: { "claude-a": { from: "/gone/claude-a", to: "/new", at: "2026-11-17T00:00:00Z" } },
    });
    let reads = 0;
    const read = async () => {
      reads += 1;
      return s;
    };
    await expect(settledAccount(s, "claude-a", read, { attempts: 3, pause: async () => {} })).rejects.toThrow(
      "zerosub launch: account Work is still moving from /gone/claude-a to /new",
    );
    expect(reads).toBe(2);
  });

  it("stops when the home folder is missing and no move explains it", async () => {
    const s = state([account({ id: "claude-a", label: "Work", home: "/gone/claude-a" })]);
    await expect(settledAccount(s, "claude-a", async () => s, { attempts: 2, pause: async () => {} })).rejects.toThrow(
      "zerosub launch: account Work has no home at /gone/claude-a",
    );
  });
});

describe("earlyLines", () => {
  it("draws the service's lines, and none when switching or both lines are off", () => {
    expect(earlyLines({ ...prefs, switchEarlyAt: 80, switchEarlyWeeklyAt: 95 })).toEqual({ short: 80, long: 95 });
    expect(earlyLines({ ...prefs, autoSwitch: false })).toBeNull();
    expect(earlyLines({ ...prefs, switchEarlyAt: 100, switchEarlyWeeklyAt: 100 })).toBeNull();
  });
});

describe("shellExports", () => {
  it("sets, clears and quotes for a POSIX shell", () => {
    expect(shellExports({ CLAUDE_CONFIG_DIR: "/homes/it's", CLAUDE_SECURESTORAGE_CONFIG_DIR: null })).toBe(
      "export CLAUDE_CONFIG_DIR='/homes/it'\\''s'\nunset CLAUDE_SECURESTORAGE_CONFIG_DIR",
    );
  });
});
