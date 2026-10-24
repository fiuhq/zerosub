import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, TurnEvent, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { prepareKimiHome } from "./homes";
import { kimiBaseUrl, parseKimiLogin, parseKimiUsage, readKimiSignIn, readKimiToken } from "./kimi";
import { detectKimiLimit, detectKimiSignOut } from "./limits";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredAccount } from "./state";
import { preferences } from "../shared/preferences";

let root: string;
const saved = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, PASEO_HOME: process.env.PASEO_HOME };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-kimi-")));
  process.env.PASEO_HOME = join(root, "paseo");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("Kimi sign-in", () => {
  it("follows the login's OAuth host to the global API, and defaults to mainland China", async () => {
    await writeFile(join(root, "config.toml"), '[services.managed]\nstorage = "file"\nkey = "oauth/kimi-code-global"\noauth_host = "https://auth.kimi.ai"\n');
    expect(await readKimiSignIn(root)).toEqual({ name: "kimi-code-global", region: "global", keyring: false });
    expect(kimiBaseUrl("global", {})).toBe("https://api.kimi.ai/coding/v1");
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await readKimiSignIn(empty)).toEqual({ name: "kimi-code", region: "mainland-cn", keyring: false });
    expect(kimiBaseUrl("mainland-cn", {})).toBe("https://api.kimi.com/coding/v1");
  });

  it("falls back to the install-channel region marker, and honours a base URL override", async () => {
    await writeFile(join(root, "region"), "global\n");
    expect((await readKimiSignIn(root)).region).toBe("global");
    expect(kimiBaseUrl("global", { KIMI_CODE_BASE_URL: "https://proxy.example/v1/" })).toBe("https://proxy.example/v1");
  });

  it("notices a login kept in the keyring", async () => {
    await writeFile(join(root, "config.toml"), 'storage = "keyring"\nkey = "oauth/kimi-code"\n');
    expect((await readKimiSignIn(root)).keyring).toBe(true);
  });

  it("reads the named token first, then any other", async () => {
    await mkdir(join(root, "credentials"));
    await writeFile(join(root, "credentials", "other.json"), JSON.stringify({ access_token: "b", refresh_token: "rb", expires_at: 1 }));
    expect((await readKimiToken(root, "kimi-code"))?.accessToken).toBe("b");
    await writeFile(join(root, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "a", refresh_token: "ra", expires_at: 2 }));
    expect(await readKimiToken(root, "kimi-code")).toEqual({ accessToken: "a", refreshToken: "ra", expiresAt: 2 });
  });

  it("reads the link and code `kimi login` prints", () => {
    const output = [
      "",
      "Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234",
      "If the browser did not open, paste the URL above and enter code: ABCD-1234",
      "Code expires in 600s.",
    ].join("\n");
    expect(parseKimiLogin(output)).toEqual({ url: "https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234", code: "ABCD-1234" });
    expect(parseKimiLogin("Starting…")).toBeNull();
  });
});

describe("Kimi usage", () => {
  it("reads every plan window /usages reports", () => {
    const windows = parseKimiUsage({
      usages: {
        limit_5h: { used_ratio: 0.42, reset_time: "2026-10-24T15:00:00Z" },
        limit_7d: { used_ratio: "0.1" },
        limit_month_total: { used_ratio: 1.3, reset_time: "" },
        limit_month_code: { used_ratio: 0.05, reset_time: "2026-11-01T00:00:00Z" },
        limit_unknown: { used_ratio: 0.9 },
      },
    });
    expect(windows).toEqual([
      { id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: "2026-10-24T15:00:00Z" },
      { id: "seven_day", label: "Weekly", usedPercent: 10, resetsAt: null },
      { id: "month", label: "Monthly", usedPercent: 100, resetsAt: null },
      { id: "month_code", label: "Monthly · coding", usedPercent: 5, resetsAt: "2026-11-01T00:00:00Z" },
    ]);
    expect(parseKimiUsage({})).toEqual([]);
    expect(parseKimiUsage(null)).toEqual([]);
  });
});

function failed(message: string): TurnEvent {
  return { outcome: { kind: "failed", error: { message } }, timeline: [], turnId: null };
}

describe("Kimi limits", () => {
  it("tells a balance from a spent quota from a throttle", () => {
    expect(detectKimiLimit(failed("Your account is suspended due to insufficient balance, please recharge your account"))).toMatchObject({ kind: "budget" });
    expect(detectKimiLimit(failed("You exceeded your current token quota: please check your plan"))).toMatchObject({ kind: "window" });
    expect(detectKimiLimit(failed("You exceeded your current token quota: please check your plan"))?.suspected).toBeUndefined();
    expect(detectKimiLimit(failed("429 Too Many Requests"))).toMatchObject({ kind: "window", suspected: true });
  });

  it("ignores an ordinary reply that talks about rate limits", () => {
    const reply = { type: "assistant_message", text: "The API answers 429 when you hit its rate limit." } as unknown as AgentTimelineItem;
    expect(detectKimiLimit({ outcome: { kind: "completed" }, timeline: [reply], turnId: "t" })).toBeNull();
  });

  it("recognises a sign-in that has to be renewed", () => {
    expect(detectKimiSignOut(failed('Stored token for "kimi-code" was rejected; re-login required.'))).not.toBeNull();
    expect(detectKimiSignOut(failed("auth.login_required: Run /login to authenticate with the OAuth provider."))).not.toBeNull();
    expect(detectKimiSignOut(failed("429 Too Many Requests"))).toBeNull();
  });
});

describe("prepareKimiHome", () => {
  it("shares history and settings but keeps the sign-in per account, seeding its config from main", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "kimi-a");
    process.env.KIMI_CODE_HOME = main;
    await mkdir(join(main, "credentials"), { recursive: true });
    await writeFile(join(main, "credentials", "kimi-code.json"), "{}");
    await writeFile(join(main, "config.toml"), 'default_model = "kimi-k3"\n');
    await writeFile(join(main, "mcp.json"), "{}");
    await writeFile(join(main, "region"), "global");
    await writeFile(join(main, "region.json"), "{}");
    await writeFile(join(main, "device_id"), "main-device");
    await prepareKimiHome(home, true);

    const link = async (name: string) => {
      const entry = await lstat(join(home, name)).catch(() => null);
      return entry?.isSymbolicLink() ? readlink(join(home, name)) : null;
    };
    expect(await link("sessions")).toBe(join(main, "sessions"));
    expect(await link("mcp.json")).toBe(join(main, "mcp.json"));
    expect(await link("region")).toBe(join(main, "region"));
    for (const name of ["credentials", "region.json", "device_id"]) expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    expect(await link("config.toml")).toBeNull();
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe('default_model = "kimi-k3"\n');

    // The account's own config is never overwritten by later syncs.
    await writeFile(join(home, "config.toml"), 'key = "oauth/kimi-code"\n');
    await prepareKimiHome(home, true);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe('key = "oauth/kimi-code"\n');
  });
});

// ------------------------------------------------------------------ suspected limits in the service

const MAIN = MAIN_ACCOUNT_ID.kimi;
const SPARE = "kimi-spare";
const AGENT = "agent-1";

function account(id: string, kind: "main" | "managed"): StoredAccount {
  return {
    id,
    family: "kimi",
    label: id,
    autoLabel: false,
    kind,
    home: kind === "main" ? null : join(root, id),
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

async function setUp(mainFiveHour: number) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [account(MAIN, "main"), account(SPARE, "managed")],
      sessions: { [AGENT]: { accountId: MAIN, family: "kimi", openedAt: new Date().toISOString() } },
    }),
  );
  const reading = (percent: number): UsageRead => ({
    fetchedAt: new Date().toISOString(),
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    error: null,
    cached: false,
    resets: null,
  });
  const adapter = {
    family: "kimi",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => ({ KIMI_CODE_HOME: home }),
    identity: async () => null,
    usage: async (home: string | null) => reading(home ? 0 : mainFiveHour),
    redeemReset: async () => ({ outcome: "none", message: "none", left: null }),
    logout: async () => undefined,
    detectLimit: detectKimiLimit,
    detectSignOut: () => null,
    environmentWarning: () => null,
  } as unknown as FamilyAdapter;
  const reopened: string[] = [];
  const agent = { id: AGENT, provider: "kimi", status: "idle", archivedAt: null };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => undefined,
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const context = { paseo } as never;
  const service = new Service(
    { claude: adapter, codex: adapter, kimi: adapter },
    store,
    { resolve: async () => ({ kimi: "kimi" as const }) } as unknown as FamilyResolver,
    {
      locate: async () => "/usr/local/bin/paseo",
      reopen: async (id: string) => {
        reopened.push(id);
        await service.onSessionOpen({ agentId: AGENT, provider: "kimi", reason: "refresh", purpose: "interactive", env: {} } as never, context);
        return { ok: true as const };
      },
    } as unknown as Reopener,
  );
  service.setPreferences(preferences.schema.parse({}));
  const turn = (message: string) =>
    service.onTurnEnded({ agent: { id: AGENT, provider: "kimi" }, turnId: "t", outcome: { kind: "failed", error: { message } }, timeline: [] } as never, context);
  return { store, reopened, turn };
}

describe("a suspected Kimi limit", () => {
  it("moves the agent once a fresh reading shows a full window", async () => {
    const { store, reopened, turn } = await setUp(100);
    await turn("429 Too Many Requests");
    expect(reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(SPARE);
    expect(state.accounts.find((entry) => entry.id === MAIN)?.limitedUntil).not.toBeNull();
  });

  it("is a passing throttle while the reading still shows room", async () => {
    const { store, reopened, turn } = await setUp(40);
    await turn("429 Too Many Requests");
    expect(reopened).toEqual([]);
    expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).toBeNull();
  });
});

