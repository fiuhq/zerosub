import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FAMILY_PORTABLE, type LoginMethod } from "../shared/model";
import { ProgressEmitter, type EnvPatch, type FamilyAdapter, type Identity, type LoginHandle, type RedeemReply, type UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { writeJsonAtomic } from "./json-file";
import { detectOpenCodeGoLimit, detectOpenCodeGoSignOut } from "./limits";
import { run } from "./process";

/** OpenCode's integration for the Go subscription, and the variable it takes a key from. */
export const GO_INTEGRATION = "opencode-go";
const KEY_ENV = "OPENCODE_API_KEY";
/**
 * Where Go keys are made, and an endpoint that tells a working key from a wrong one: Go's model list
 * answers 401 "Invalid credential" to a bad key. (The `inference/go` routes only serve OpenCode's own
 * sessions.)
 */
const KEY_PAGE = "https://opencode.ai/console";
const GO_MODELS = "https://opencode.ai/zen/go/v1/models";

/** OpenCode's data folder (`$XDG_DATA_HOME/opencode`), where its database keeps chats and sign-ins. */
export function openCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

const keyPath = (home: string) => join(home, "opencode-go.json");

export async function readGoKey(home: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(keyPath(home), "utf8")) as { key?: unknown };
    return typeof value.key === "string" && value.key ? value.key : null;
  } catch {
    return null;
  }
}

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Whether OpenCode itself keeps a Go key. OpenCode uses a saved key before `OPENCODE_API_KEY`, so
 * while it has one, ZeroSub's accounts can't take effect. Reads which integrations have a saved
 * credential, never the credential, from OpenCode's database (or its older `auth.json`).
 */
export async function openCodeHasSavedGoKey(dataDir: string = openCodeDataDir()): Promise<boolean> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "opencode.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT 1 AS found FROM credential WHERE integration_id = ? LIMIT 1").get(GO_INTEGRATION) as { found?: number } | undefined;
      return row?.found === 1;
    } finally {
      db.close();
    }
  } catch {
    // No database (or no SQLite in this runtime): OpenCode 1.x kept sign-ins in auth.json.
    try {
      const auth = JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8")) as Record<string, unknown>;
      return Boolean(auth[GO_INTEGRATION]);
    } catch {
      return false;
    }
  }
}

async function keyWorks(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(GO_MODELS, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return { ok: true };
    if (response.status !== 401) return { ok: false, message: `OpenCode answered HTTP ${response.status}; try again.` };
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    return {
      ok: false,
      message: body?.error?.code === "api_key_expired" ? "That key has expired. Make a new one in the OpenCode Console." : "OpenCode didn't accept that key.",
    };
  } catch (error) {
    return { ok: false, message: `Couldn't reach OpenCode: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * An account is an OpenCode Go key that ZeroSub keeps in the account's folder and hands to the
 * agent's session as `OPENCODE_API_KEY`. Paseo starts a separate OpenCode server for a session with
 * its own environment, and chats stay in OpenCode's one database, so they open on any account.
 */
export class OpenCodeGoAdapter implements FamilyAdapter {
  readonly family = "opencode" as const;
  readonly portable = FAMILY_PORTABLE.opencode;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    return { [KEY_ENV]: home ? await readGoKey(home) : null };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  async identity(home: string | null): Promise<Identity> {
    if (home) {
      const key = await readGoKey(home);
      if (!key) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
      return { signedIn: true, email: null, plan: "Go", organization: null, identity: `opencode-go|${keyFingerprint(key)}` };
    }
    const signedIn = Boolean(process.env[KEY_ENV]) || (await openCodeHasSavedGoKey());
    return { signedIn, email: null, plan: signedIn ? "Go" : null, organization: null, identity: null };
  }

  async usage(): Promise<UsageRead> {
    return { fetchedAt: new Date().toISOString(), windows: [], error: "OpenCode Go shows usage only in the OpenCode Console.", cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "OpenCode Go has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) throw new Error("Your OpenCode CLI login is the Go key OpenCode keeps itself; add other keys here as accounts.");
    return new GoKeyLogin(home);
  }

  async logout(_home: string): Promise<void> {
    // The key lives in the home itself, which is deleted next.
  }

  /** The `opencode` provider runs every model OpenCode knows; only Go models bill a Go account. */
  ownsModel(model: string | null): boolean {
    return model === null || model.startsWith(`${GO_INTEGRATION}/`);
  }

  detectLimit = detectOpenCodeGoLimit;
  detectSignOut = detectOpenCodeGoSignOut;

  environmentWarning(env: NodeJS.ProcessEnv): string | null {
    return env[KEY_ENV]
      ? "The daemon's environment sets OPENCODE_API_KEY. OpenCode agents on your CLI login use it; agents on added accounts use their own key."
      : null;
  }

  /** OpenCode's own saved Go key wins over every account here, so say so while it has one. */
  async setupWarning(): Promise<string | null> {
    return (await openCodeHasSavedGoKey())
      ? "OpenCode keeps its own OpenCode Go key, and uses it ahead of the key ZeroSub gives each agent. To let ZeroSub pick the Go account per agent, add that key here too, then disconnect OpenCode Go in OpenCode (/connect)."
      : null;
  }
}

/** Paste a key made in the OpenCode Console; it is checked against OpenCode before it is kept. */
class GoKeyLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle: (result: { ok: boolean; message: string | null }) => void = () => undefined;

  constructor(private readonly home: string) {
    super();
    this.finished = new Promise((resolve) => (this.settle = resolve));
    this.update({
      step: "waiting",
      codeUrl: KEY_PAGE,
      message: "Open the OpenCode Console, copy the API key of the workspace with the Go plan, and paste it here.",
    });
  }

  async submitCode(code: string): Promise<void> {
    const key = code.trim();
    if (!key) throw new Error("Paste the API key from the OpenCode Console.");
    this.update({ step: "verifying" });
    const check = await keyWorks(key);
    if (!check.ok) {
      this.update({ step: "waiting", message: check.message });
      throw new Error(check.message);
    }
    await writeJsonAtomic(keyPath(this.home), { key });
    this.settle({ ok: true, message: null });
  }

  cancel(): void {
    this.settle({ ok: false, message: "Sign-in was canceled." });
  }
}
