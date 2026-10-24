import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnEvent } from "./adapter";
import { CopilotAdapter, copilotCacheDir, copilotUser, parseCommentedJson, parseCopilotCache, parseCopilotLogin } from "./copilot";
import { prepareCopilotHome } from "./homes";
import { detectCopilotLimit, detectCopilotSignOut } from "./limits";

let root: string;
const saved = { COPILOT_HOME: process.env.COPILOT_HOME, PASEO_HOME: process.env.PASEO_HOME, GH_TOKEN: process.env.GH_TOKEN };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-copilot-")));
  process.env.PASEO_HOME = join(root, "paseo");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

/** `config.json` exactly as Copilot CLI 1.0.103 writes it after `copilot login`. */
const SIGNED_IN_CONFIG = `// User settings belong in settings.json.
// This file is managed automatically.
{
  "loggedInUsers": [
    {
      "host": "https://github.com",
      "login": "octo-user",
      "kind": "githubDotCom"
    }
  ],
  "lastLoggedInUser": {
    "host": "https://github.com",
    "login": "octo-user"
  }
}
`;

describe("Copilot sign-in", () => {
  it("reads the signed-in user from the commented config.json", async () => {
    await writeFile(join(root, "config.json"), SIGNED_IN_CONFIG);
    expect(await copilotUser(root)).toEqual({ login: "octo-user", host: "https://github.com" });
    expect(parseCommentedJson('// note\n{"a": 1}')).toEqual({ a: 1 });
  });

  it("finds no user in a home that never signed in", async () => {
    await writeFile(join(root, "config.json"), '// User settings belong in settings.json.\n{\n  "firstLaunchAt": "2026-08-11T07:15:20.426Z"\n}\n');
    expect(await copilotUser(root)).toBeNull();
    expect(await copilotUser(join(root, "missing"))).toBeNull();
  });

  it("reads the link and code `copilot login --device-code` prints", () => {
    const output = "To authenticate, visit https://github.com/login/device and enter code ABCD-1234\nWaiting for authorization...\n";
    expect(parseCopilotLogin(output)).toEqual({ url: "https://github.com/login/device", code: "ABCD-1234" });
    expect(parseCopilotLogin("Waiting for authorization...")).toBeNull();
  });

  it("keeps the daemon's tokens away from an added account so its own sign-in applies", async () => {
    process.env.GH_TOKEN = "from-daemon";
    const adapter = new CopilotAdapter();
    expect(await adapter.env("/homes/copilot-a")).toMatchObject({ COPILOT_HOME: "/homes/copilot-a", GH_TOKEN: "" });
    expect(await adapter.env(null)).toEqual({ COPILOT_HOME: null });
    expect(adapter.environmentWarning({ GH_TOKEN: "x" })).toMatch(/GH_TOKEN/);
    expect(adapter.environmentWarning({})).toBeNull();
  });
});

/** The shape of Copilot CLI's user cache, with made-up users. */
function cache(entries: Array<{ login: string; at: string; snapshots?: Record<string, unknown>; reset?: string }>): string {
  const body: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    body[`v1:${index}`] = {
      schemaVersion: 1,
      generation: "g",
      retrievedAt: entry.at,
      response: {
        login: entry.login,
        copilot_plan: "individual",
        ...(entry.reset ? { quota_reset_date: entry.reset } : {}),
        ...(entry.snapshots ? { quota_snapshots: entry.snapshots } : {}),
      },
    };
  });
  return `// Disposable cache for Copilot user responses, safe to delete. Managed automatically.\n${JSON.stringify({ copilotUserCache: body })}`;
}

describe("Copilot usage", () => {
  it("reads the newest cached quota for the user, skipping unlimited allowances", () => {
    const text = cache([
      { login: "octo-user", at: "2026-10-06T04:16:42.452Z", reset: "2026-11-01", snapshots: { premium_interactions: { entitlement: 1500, percent_remaining: 50, unlimited: false } } },
      {
        login: "Octo-User",
        at: "2026-10-24T01:48:06.212Z",
        reset: "2026-11-01",
        snapshots: {
          chat: { entitlement: 0, percent_remaining: 100, unlimited: true },
          completions: { entitlement: 0, percent_remaining: 100, unlimited: true },
          premium_interactions: { entitlement: 1500, percent_remaining: 98, unlimited: false },
        },
      },
      { login: "someone-else", at: "2026-10-24T05:00:00.000Z", snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 1 } } },
    ]);
    expect(parseCopilotCache(text, "octo-user")).toEqual({
      fetchedAt: "2026-10-24T01:48:06.212Z",
      plan: "individual",
      windows: [{ id: "premium_interactions", label: "Monthly · premium requests", usedPercent: 2, resetsAt: "2026-11-01T00:00:00.000Z" }],
    });
  });

  it("shows a free plan's chat and completions allowances", () => {
    const text = cache([
      {
        login: "free-user",
        at: "2026-10-01T00:00:00.000Z",
        snapshots: {
          chat: { entitlement: 50, percent_remaining: 40 },
          completions: { entitlement: 2000, percent_remaining: 100 },
          premium_interactions: { entitlement: 0, percent_remaining: 0 },
        },
      },
    ]);
    expect(parseCopilotCache(text, "free-user")?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["chat", 60],
      ["completions", 0],
    ]);
  });

  it("has nothing for a user it never cached, or a broken file", () => {
    expect(parseCopilotCache(cache([]), "octo-user")).toBeNull();
    expect(parseCopilotCache("not json", "octo-user")).toBeNull();
  });

  it("looks for the cache where each platform keeps it", () => {
    expect(copilotCacheDir({}, "darwin")).toMatch(/Library\/Caches\/copilot$/);
    expect(copilotCacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux")).toBe("/xdg/copilot");
    expect(copilotCacheDir({ LOCALAPPDATA: "C:\\Local" }, "win32")).toMatch(/copilot$/);
  });
});

function failed(message: string): TurnEvent {
  return { outcome: { kind: "failed", error: { message } }, timeline: [], turnId: null };
}

describe("Copilot limits", () => {
  it("tells a spent allowance from a weekly limit from a passing rate limit", () => {
    expect(detectCopilotLimit(failed("You've run out of your included AI credits for this month."))).toMatchObject({ kind: "budget" });
    expect(detectCopilotLimit(failed("No remaining quota for premium requests."))).toMatchObject({ kind: "budget" });
    expect(detectCopilotLimit(failed("You've reached your weekly rate limit for this model."))).toMatchObject({ kind: "window" });
    expect(detectCopilotLimit(failed("Sorry, you've hit the rate limit. Please try again later."))).toMatchObject({ suspected: true });
    expect(detectCopilotLimit(failed("Sorry, the file could not be read."))).toBeNull();
  });

  it("recognises a sign-in that is gone", () => {
    expect(detectCopilotSignOut(failed("Error: No authentication information found."))).not.toBeNull();
    expect(detectCopilotSignOut(failed("429 Too Many Requests"))).toBeNull();
  });
});

describe("prepareCopilotHome", () => {
  it("shares sessions and settings but keeps the signed-in user and session index per account", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "copilot-a");
    process.env.COPILOT_HOME = main;
    await mkdir(join(main, "installed-plugins"), { recursive: true });
    await writeFile(join(main, "config.json"), SIGNED_IN_CONFIG);
    await writeFile(join(main, "settings.json"), "{}");
    await writeFile(join(main, "session-store.db"), "");
    await writeFile(join(main, "session-store.db-wal"), "");
    await mkdir(join(main, "logs"));
    await prepareCopilotHome(home, true);

    const link = async (name: string) => {
      const entry = await lstat(join(home, name)).catch(() => null);
      return entry?.isSymbolicLink() ? readlink(join(home, name)) : null;
    };
    expect(await link("session-state")).toBe(join(main, "session-state"));
    expect(await link("settings.json")).toBe(join(main, "settings.json"));
    expect(await link("installed-plugins")).toBe(join(main, "installed-plugins"));
    for (const name of ["config.json", "session-store.db", "session-store.db-wal", "logs"]) {
      expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    }
  });
});

describe("removing a Copilot account", () => {
  it("leaves the keychain sign-in alone while another home still uses that GitHub user", async () => {
    const main = join(root, "main");
    const home = join(root, "paseo", "zerosub", "homes", "copilot-a");
    process.env.COPILOT_HOME = main;
    await mkdir(main, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(main, "config.json"), SIGNED_IN_CONFIG);
    await writeFile(join(home, "config.json"), SIGNED_IN_CONFIG.replace(/octo-user/g, "Octo-User"));
    // Returns before touching the keychain: main signs in as the same user.
    await expect(new CopilotAdapter().logout(home)).resolves.toBeUndefined();
  });
});
