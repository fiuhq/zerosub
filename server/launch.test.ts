import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import { earlyLines, launchAccount, shellExports } from "./launch";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-10-29T04:30:00Z");
const prefs = preferences.schema.parse({});

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
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
  return { fetchedAt: "2026-10-29T04:29:00Z", windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }], error: null, cached: false, resets: null };
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
