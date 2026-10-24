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
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect((await adapter.identity(home)).identity).toBe(`opencode-go|${keyFingerprint("sk-go-a")}`);
    expect((await adapter.identity(join(root, "empty"))).signedIn).toBe(false);
  });

  it("is signed out once OpenCode refuses its key, but not while OpenCode can't be reached", async () => {
    const home = join(root, "opencode-a");
    await mkdir(home);
    await writeFile(join(home, "opencode-go.json"), JSON.stringify({ key: "sk-go-a" }));
    const adapter = new OpenCodeGoAdapter();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect((await adapter.identity(home)).signedIn).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    expect((await adapter.identity(home)).signedIn).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Invalid credential" } }), { status: 401 }));
    expect((await adapter.identity(home)).signedIn).toBe(false);
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
      // The live endpoint's answers: 401 "Invalid credential", or `api_key_expired` for an old key.
      if (init.headers.Authorization === "Bearer old") {
        return new Response(JSON.stringify({ error: { type: "authentication_error", code: "api_key_expired" } }), { status: 401 });
      }
      return new Response(JSON.stringify(init.headers.Authorization === "Bearer good" ? { data: [] } : { error: { message: "Invalid credential" } }), {
        status: init.headers.Authorization === "Bearer good" ? 200 : 401,
      });
    });
    const login = await new OpenCodeGoAdapter().login(home, "code");
    expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://opencode.ai/console" });
    await expect(login.submitCode("bad")).rejects.toThrow(/didn't accept/);
    await expect(login.submitCode("old")).rejects.toThrow(/has expired/);
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
    expect(detectOpenCodeGoLimit(failed("Rate limit reached for requests"))).toBeNull();
    expect(detectOpenCodeGoLimit(failed("Context limit reached"))).toBeNull();
    expect(detectOpenCodeGoSignOut(failed("Invalid API key provided."))).not.toBeNull();
    expect(detectOpenCodeGoSignOut(failed('{"error":{"type":"authentication_error","code":"api_key_expired"}}'))).not.toBeNull();
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

async function setUp(model: string, siblingModels: string[] = [], options: { real?: boolean; accountId?: string; message?: string } = {}) {
  const bound = options.accountId ?? MAIN;
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [account(MAIN, "main"), account("opencode-spare", "managed")],
      sessions: Object.fromEntries(
        [model, ...siblingModels].map((_, index) => [`agent-${index + 1}`, { accountId: bound, family: "opencode", openedAt: new Date().toISOString() }]),
      ),
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
    ...(options.real ? { identity: (home: string | null) => real.identity(home), detectSignOut: detectOpenCodeGoSignOut } : {}),
  } as unknown as FamilyAdapter;
  const reopened: string[] = [];
  const agents = [model, ...siblingModels].map((value, index) => ({
    id: `agent-${index + 1}`,
    provider: "opencode",
    status: "idle",
    archivedAt: null,
    model: value,
  }));
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
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
      { agent: { id: AGENT, provider: "opencode" }, turnId: "t", outcome: { kind: "failed", error: { message: options.message ?? "Usage limit reached." } }, timeline: [] } as never,
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

  it("moves idle Go siblings off the spent account but not one on another provider's model", async () => {
    const { reopened, turn } = await setUp("opencode-go/glm-5.3", ["openrouter/some-model", "opencode-go/kimi-k3"]);
    await turn();
    await vi.waitFor(() => expect(reopened).toContain("agent-3"));
    expect(reopened).toEqual([AGENT, "agent-3"]);
  });
});

describe("an OpenCode Go key OpenCode refuses", () => {
  it("signs the account out after an Invalid credential turn", async () => {
    const home = join(root, "opencode-spare");
    await mkdir(home);
    await writeFile(join(home, "opencode-go.json"), JSON.stringify({ key: "sk-revoked" }));
    // The live endpoint's answer to a revoked key.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Invalid credential" } }), { status: 401 }));
    const { store, turn } = await setUp("opencode-go/minimax-m3", [], {
      real: true,
      accountId: "opencode-spare",
      message: "Upstream request failed: Invalid credential",
    });
    await turn();
    expect((await store.read()).accounts.find((entry) => entry.id === "opencode-spare")?.signedIn).toBe(false);
  });
});
