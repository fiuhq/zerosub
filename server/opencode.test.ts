import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, TurnEvent } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectOpenCodeGoLimit, detectOpenCodeGoSignOut } from "./limits";
import { OpenCodeGoAdapter, keyFingerprint, openCodeHasSavedGoKey, readGoKey } from "./opencode";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredAccount } from "./state";
import { everyFamily } from "./test-families";
import { preferences } from "../shared/preferences";

let root: string;
const saved = { PASEO_HOME: process.env.PASEO_HOME, OPENCODE_API_KEY: process.env.OPENCODE_API_KEY };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-opencode-")));
  process.env.PASEO_HOME = join(root, "paseo");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

/** OpenCode 2.x keeps sign-ins in its database's `credential` table. */
function database(dir: string, integrations: string[]): void {
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec("CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, active INTEGER)");
  const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, 1)");
  for (const id of integrations) insert.run(`cred-${id}`, id, "API key", JSON.stringify({ type: "key", key: "secret" }));
  db.close();
}

describe("OpenCode's own Go key", () => {
  it("is found in OpenCode's database without reading the credential", async () => {
    database(root, ["openai", "opencode-go"]);
    expect(await openCodeHasSavedGoKey(root)).toBe(true);
  });

  it("is absent when only other providers are saved", async () => {
    database(root, ["openai", "openrouter"]);
    expect(await openCodeHasSavedGoKey(root)).toBe(false);
  });

  it("falls back to OpenCode 1.x's auth.json", async () => {
    await writeFile(join(root, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "x" } }));
    expect(await openCodeHasSavedGoKey(root)).toBe(true);
    expect(await openCodeHasSavedGoKey(join(root, "missing"))).toBe(false);
  });
});

describe("an OpenCode Go account", () => {
  it("gives its session its own key, and the CLI login inherits the daemon's", async () => {
    const home = join(root, "opencode-a");
    await mkdir(home);
    await writeFile(join(home, "opencode-go.json"), JSON.stringify({ key: "sk-go-a" }));
    const adapter = new OpenCodeGoAdapter();
    expect(await adapter.env(home)).toEqual({ OPENCODE_API_KEY: "sk-go-a" });
    expect(await adapter.env(null)).toEqual({ OPENCODE_API_KEY: null });
    expect(await readGoKey(home)).toBe("sk-go-a");
    expect((await adapter.identity(home)).identity).toBe(`opencode-go|${keyFingerprint("sk-go-a")}`);
    expect((await adapter.identity(join(root, "empty"))).signedIn).toBe(false);
  });

  it("only follows turns on Go models", () => {
    const adapter = new OpenCodeGoAdapter();
    expect(adapter.ownsModel("opencode-go/glm-5.3")).toBe(true);
    expect(adapter.ownsModel("openrouter/anthropic/claude")).toBe(false);
    expect(adapter.ownsModel(null)).toBe(true);
  });

  it("keeps a pasted key only once OpenCode accepts it", async () => {
    const home = join(root, "opencode-b");
    await mkdir(home);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push(`${url} ${init.headers.Authorization}`);
      return new Response("{}", { status: init.headers.Authorization === "Bearer good" ? 200 : 401 });
    });
    const login = await new OpenCodeGoAdapter().login(home, "code");
    expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://opencode.ai/console" });
    await expect(login.submitCode("bad")).rejects.toThrow(/didn't accept/);
    expect(await readGoKey(home)).toBeNull();
    await login.submitCode("  good  ");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(JSON.parse(await readFile(join(home, "opencode-go.json"), "utf8"))).toEqual({ key: "good" });
    expect((await stat(join(home, "opencode-go.json"))).mode & 0o777).toBe(0o600);
    expect(fetched.at(-1)).toBe("https://opencode.ai/zen/go/v1/models Bearer good");
  });
});

function failed(message: string): TurnEvent {
  return { outcome: { kind: "failed", error: { message } }, timeline: [], turnId: null };
}

describe("OpenCode Go limits", () => {
  it("counts limit wording but not a bare throttle", () => {
    expect(detectOpenCodeGoLimit(failed("Usage limit reached for this 5-hour window."))).toMatchObject({ kind: "window" });
    expect(detectOpenCodeGoLimit(failed("429 Too Many Requests"))).toBeNull();
    expect(detectOpenCodeGoSignOut(failed("Invalid API key provided."))).not.toBeNull();
  });
});

// ------------------------------------------------------------------ the model gate in the service

const MAIN = MAIN_ACCOUNT_ID.opencode;
const AGENT = "agent-1";

function account(id: string, kind: "main" | "managed"): StoredAccount {
  return {
    id,
    family: "opencode",
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

async function setUp(model: string) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [account(MAIN, "main"), account("opencode-spare", "managed")],
      sessions: { [AGENT]: { accountId: MAIN, family: "opencode", openedAt: new Date().toISOString() } },
    }),
  );
  const real = new OpenCodeGoAdapter();
  const adapter = {
    family: "opencode",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: async () => null,
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: null }),
    logout: async () => undefined,
    ownsModel: (value: string | null) => real.ownsModel(value),
    detectLimit: detectOpenCodeGoLimit,
    detectSignOut: () => null,
    environmentWarning: () => null,
  } as unknown as FamilyAdapter;
  const reopened: string[] = [];
  const agent = { id: AGENT, provider: "opencode", status: "idle", archivedAt: null, model };
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
    everyFamily(adapter),
    store,
    { resolve: async () => ({ opencode: "opencode" as const }) } as unknown as FamilyResolver,
    {
      locate: async () => "/usr/local/bin/paseo",
      reopen: async (id: string) => {
        reopened.push(id);
        return { ok: true as const };
      },
    } as unknown as Reopener,
  );
  service.setPreferences(preferences.schema.parse({}));
  const turn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "opencode" }, turnId: "t", outcome: { kind: "failed", error: { message: "Usage limit reached." } }, timeline: [] } as never,
      context,
    );
  return { store, reopened, turn };
}

describe("an OpenCode agent's limit", () => {
  it("moves a Go agent off its spent account", async () => {
    const { store, reopened, turn } = await setUp("opencode-go/glm-5.3");
    await turn();
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).not.toBeNull();
  });

  it("leaves the Go account alone when the agent runs another provider's model", async () => {
    const { store, reopened, turn } = await setUp("openrouter/some-model");
    await turn();
    expect(reopened).toEqual([]);
    expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).toBeNull();
  });
});
