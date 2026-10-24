import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { chooseAccount, reservedElsewhere, type RouteInput } from "./routing";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MAIN = MAIN_ACCOUNT_ID.claude;
const WORK = "claude-work";
const SPARE = "claude-spare";
const FLXBL = "prj_flxbl";
const HOME = "prj_home";
const AGENT = "agent-1";

function account(id: string, kind: "main" | "managed" = "managed", patch: Partial<StoredAccount> = {}): StoredAccount {
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
    ...patch,
  };
}

function reading(fiveHour: number): Usage {
  return {
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: fiveHour, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() }],
    error: null,
    cached: false,
    resets: null,
  };
}

const stateWith = (patch: Partial<StoredState> = {}): StoredState => ({
  ...emptyState(),
  accounts: [account(MAIN, "main"), account(WORK), account(SPARE)],
  projects: [{ projectId: FLXBL, accountId: WORK, name: "flxbl-io/sfp-pro" }],
  ...patch,
});

const route = (state: StoredState, patch: Partial<RouteInput> = {}) =>
  chooseAccount(state, {
    agentId: AGENT,
    family: "claude",
    reason: "create",
    now: NOW,
    autoSwitch: true,
    balanceNewAgents: false,
    portable: true,
    usageOf: () => null,
    ...patch,
  });

describe("project accounts", () => {
  it("put a project's agents on its account instead of the default", () => {
    expect(route(stateWith(), { projectId: FLXBL })?.account.id).toBe(WORK);
  });

  it("keep other projects' agents off an account set aside for a project", () => {
    expect(route(stateWith({ defaults: { claude: WORK, codex: null } }), { projectId: HOME })?.account.id).not.toBe(WORK);
    expect(reservedElsewhere(stateWith(), HOME)).toEqual(new Set([WORK]));
    expect(reservedElsewhere(stateWith(), FLXBL)).toEqual(new Set());
  });

  it("still use a project's account when it serves several projects", () => {
    const state = stateWith({ projects: [{ projectId: FLXBL, accountId: WORK, name: null }, { projectId: HOME, accountId: WORK, name: null }] });
    expect(route(state, { projectId: HOME })?.account.id).toBe(WORK);
    expect(reservedElsewhere(state, HOME)).toEqual(new Set());
  });

  it("leave an account chosen for the agent, and one a limit moved it to", () => {
    const at = new Date(NOW).toISOString();
    for (const source of ["user", "auto"] as const) {
      const state = stateWith({ bindings: { [AGENT]: { accountId: SPARE, source, at } } });
      expect(route(state, { projectId: FLXBL, reason: "resume" })?.account.id).toBe(SPARE);
    }
  });

  it("win over spreading new agents across accounts", () => {
    const at = new Date(NOW).toISOString();
    const state = stateWith({ bindings: { [AGENT]: { accountId: SPARE, source: "balance", at } } });
    expect(route(state, { projectId: FLXBL, reason: "resume" })?.account.id).toBe(WORK);
  });

  it("fail over only to accounts not set aside for another project", () => {
    const limited = account(WORK, "managed", { limitedUntil: new Date(NOW + 3_600_000).toISOString(), limitKind: "window" });
    const state = stateWith({
      accounts: [account(MAIN, "main"), limited, account(SPARE)],
      projects: [
        { projectId: FLXBL, accountId: WORK, name: null },
        { projectId: HOME, accountId: SPARE, name: null },
      ],
    });
    const decision = route(state, { projectId: FLXBL, usageOf: (id) => (id === MAIN ? reading(10) : reading(0)) });
    expect(decision?.account.id).toBe(MAIN);
    expect(decision?.skipped).toMatchObject({ why: "limited" });
  });

  it("fall back to the default when every other account is set aside", () => {
    const state = stateWith({ accounts: [account(MAIN, "main"), account(WORK)], projects: [{ projectId: FLXBL, accountId: MAIN, name: null }] });
    expect(route(state, { projectId: HOME })?.account.id).toBe(WORK);
    const only = stateWith({ accounts: [account(MAIN, "main")], projects: [{ projectId: FLXBL, accountId: MAIN, name: null }] });
    expect(route(only, { projectId: HOME })?.account.id).toBe(MAIN);
  });
});

// ------------------------------------------------------------------ the service

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-projects-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const adapter = {
  family: "claude",
  portable: true,
  usageSpacingMs: 0,
  available: async () => ({ ok: true, detail: null }),
  prepareHome: async () => undefined,
  env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : { CLAUDE_CONFIG_DIR: null }),
  identity: async () => null,
  usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
  redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
  logout: async () => undefined,
  detectLimit: () => null,
  detectSignOut: () => null,
} as unknown as FamilyAdapter;

async function setUp(state: Partial<StoredState> = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, { accounts: [account(MAIN, "main"), account(WORK)], ...state }));
  const workspaceReads: string[] = [];
  const reopened: string[] = [];
  const agent = { id: AGENT, provider: "claude", status: "idle", archivedAt: null };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    projects: {
      list: async () => ({
        projects: [
          { projectId: FLXBL, projectDisplayName: "flxbl-io/sfp-pro", projectRootPath: "/work/sfp-pro" },
          { projectId: HOME, projectDisplayName: "fiuhq/core", projectRootPath: "/work/core" },
        ],
      }),
    },
    workspaces: {
      ref: (id: string) => ({
        refresh: async () => {
          workspaceReads.push(id);
          return { id, projectId: id === "wks_flxbl" ? FLXBL : HOME };
        },
      }),
    },
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
  const open = (workspaceId: string, reason = "create") =>
    service.onSessionOpen({ agentId: AGENT, workspaceId, provider: "claude", cwd: "/work", reason, purpose: "interactive", env: {} } as never, context);
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await open("wks_flxbl", "refresh");
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const }) };
  const service = new Service({ claude: adapter, codex: adapter }, store, families as unknown as FamilyResolver, reopener as unknown as Reopener);
  return { service, store, open, paseo, reopened, workspaceReads };
}

describe("project accounts in the service", () => {
  it("route a session by its workspace's project, reading each workspace once", async () => {
    const { store, open, workspaceReads } = await setUp({ projects: [{ projectId: FLXBL, accountId: WORK, name: null }] });
    const first = await open("wks_flxbl");
    expect(first?.env.CLAUDE_CONFIG_DIR).toBe(`/homes/${WORK}`);
    await open("wks_flxbl", "resume");
    expect(workspaceReads).toEqual(["wks_flxbl"]);
    expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: WORK, projectId: FLXBL });
  });

  it("move a project's open agents when it gets an account, and take the project from its old one", async () => {
    const { service, store, open, paseo, reopened } = await setUp({ projects: [{ projectId: FLXBL, accountId: MAIN, name: null }] });
    await open("wks_flxbl");
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    const summary = await service.setProjects(paseo as never, WORK, [FLXBL]);
    expect(summary.reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.projects).toEqual([{ projectId: FLXBL, accountId: WORK, name: "flxbl-io/sfp-pro" }]);
    expect(state.sessions[AGENT]?.accountId).toBe(WORK);
    expect((await service.listProjects(paseo as never)).find((project) => project.projectId === FLXBL)?.accounts).toEqual({ claude: WORK });
  });

  it("refuse a project Paseo doesn't know", async () => {
    const { service, paseo } = await setUp();
    await expect(service.setProjects(paseo as never, WORK, ["prj_gone"])).rejects.toThrow(/no project prj_gone/);
  });

  it("forget a removed account's projects", async () => {
    const { service, store, paseo } = await setUp({ projects: [{ projectId: FLXBL, accountId: WORK, name: null }] });
    await service.remove(paseo as never, WORK);
    expect((await store.read()).projects).toEqual([]);
  });
});
