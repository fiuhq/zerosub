import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { FAMILY_PORTABLE, type LoginMethod, type UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
  type UsageRead,
} from "./adapter";
import { providerCommand, quietOpenerDir } from "./binaries";
import { prepareCopilotHome } from "./homes";
import { detectCopilotLimit, detectCopilotSignOut } from "./limits";
import { homesDir, mainCopilotHome } from "./paths";
import { run, stripAnsi } from "./process";

/** Copilot CLI prefers these over a stored sign-in, in this order, so an added account must not inherit them. */
const TOKEN_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
/** The macOS keychain service Copilot CLI stores sign-ins under, one item per `<host>:<login>`. */
const KEYCHAIN_SERVICE = "copilot-cli";

/** Reads Copilot's JSON files, which start with `//` comment lines. */
export function parseCommentedJson(text: string): unknown {
  return JSON.parse(text.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n"));
}

export interface CopilotUser {
  login: string;
  /** e.g. `https://github.com`. */
  host: string;
}

/** The GitHub user a Copilot home last signed in as (`config.json` → `lastLoggedInUser`). */
export async function copilotUser(home: string): Promise<CopilotUser | null> {
  try {
    const config = parseCommentedJson(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    const user = config.lastLoggedInUser as { login?: unknown; host?: unknown } | undefined;
    if (typeof user?.login !== "string" || !user.login) return null;
    return { login: user.login, host: typeof user.host === "string" && user.host ? user.host : "https://github.com" };
  } catch {
    return null;
  }
}

/**
 * Whether the keychain still holds this user's Copilot sign-in. Reads the item's attributes only, so
 * the keychain never asks for permission. Elsewhere the home's record is trusted.
 */
async function hasStoredSignIn(user: CopilotUser): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const result = await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", `${user.host}:${user.login}`], {
    timeoutMs: 10_000,
  });
  return result.code === 0;
}

/** Where Copilot CLI caches each user's account and quota response. */
export function copilotCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "copilot");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "copilot");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "copilot");
}

interface QuotaSnapshot {
  entitlement?: number;
  percent_remaining?: number;
  unlimited?: boolean;
}

const QUOTA_LABEL: Record<string, string> = {
  premium_interactions: "Monthly · premium requests",
  chat: "Monthly · chat",
  completions: "Monthly · completions",
};

/** The newest cached Copilot response for `login`, read into usage windows; null when there is none. */
export function parseCopilotCache(text: string, login: string): { fetchedAt: string; windows: UsageWindow[]; plan: string | null } | null {
  let cache: Record<string, { retrievedAt?: string; response?: Record<string, unknown> }>;
  try {
    cache = ((parseCommentedJson(text) as Record<string, unknown>).copilotUserCache ?? {}) as typeof cache;
  } catch {
    return null;
  }
  const entries = Object.values(cache)
    .filter((entry) => typeof entry?.response?.login === "string" && (entry.response.login as string).toLowerCase() === login.toLowerCase())
    .sort((a, b) => Date.parse(b.retrievedAt ?? "") - Date.parse(a.retrievedAt ?? ""));
  const newest = entries[0];
  if (!newest?.response || !newest.retrievedAt) return null;
  const response = newest.response;
  const resetDate = typeof response.quota_reset_date === "string" && response.quota_reset_date ? response.quota_reset_date : null;
  const resetsAt = resetDate ? new Date(resetDate.length === 10 ? `${resetDate}T00:00:00Z` : resetDate).toISOString() : null;
  const snapshots = (response.quota_snapshots ?? {}) as Record<string, QuotaSnapshot>;
  const windows: UsageWindow[] = [];
  for (const [id, snapshot] of Object.entries(snapshots)) {
    if (!snapshot || snapshot.unlimited || !snapshot.entitlement || typeof snapshot.percent_remaining !== "number") continue;
    windows.push({
      id,
      label: QUOTA_LABEL[id] ?? `Monthly · ${id.replace(/_/g, " ")}`,
      usedPercent: Math.min(100, Math.max(0, 100 - snapshot.percent_remaining)),
      resetsAt,
    });
  }
  const plan = typeof response.copilot_plan === "string" && response.copilot_plan ? response.copilot_plan : null;
  return { fetchedAt: new Date(newest.retrievedAt).toISOString(), windows, plan };
}

const SIGNED_OUT: Identity = { signedIn: false, email: null, plan: null, organization: null, identity: null };

export class CopilotAdapter implements FamilyAdapter {
  readonly family = "copilot" as const;
  /** Session events live in the shared `session-state`, and Copilot resolves the sign-in on resume. */
  readonly portable = FAMILY_PORTABLE.copilot;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { COPILOT_HOME: null };
    const patch: EnvPatch = { COPILOT_HOME: home };
    for (const key of TOKEN_KEYS) if (process.env[key]) patch[key] = "";
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("copilot");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareCopilotHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const user = await copilotUser(home ?? mainCopilotHome());
    if (!user || !(await hasStoredSignIn(user))) {
      // The CLI login can run on a token from the daemon's environment instead of a stored sign-in.
      const fromEnv = !home && TOKEN_KEYS.some((key) => process.env[key]);
      return fromEnv ? { signedIn: true, email: null, plan: null, organization: null, identity: null } : SIGNED_OUT;
    }
    const host = new URL(user.host).host;
    const cached = await this.cachedUsage(user.login);
    return {
      signedIn: true,
      email: user.login,
      plan: cached?.plan ?? null,
      organization: host === "github.com" ? null : host,
      identity: `copilot|${host}|${user.login.toLowerCase()}`,
    };
  }

  private async cachedUsage(login: string) {
    const text = await readFile(join(copilotCacheDir(), "copilot-user-cache.json"), "utf8").catch(() => null);
    return text ? parseCopilotCache(text, login) : null;
  }

  /** From Copilot CLI's own cache of each user's quota: no token is read, so nothing prompts. */
  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const user = await copilotUser(home ?? mainCopilotHome());
    if (!user) {
      const fromEnv = !home && TOKEN_KEYS.some((key) => process.env[key]);
      const error = fromEnv
        ? "This login uses a token from the daemon's environment, so Copilot's usage isn't known for it."
        : "Usage shows once this account is signed in.";
      return { fetchedAt, windows: [], error, cached: false, resets: null };
    }
    const cached = await this.cachedUsage(user.login);
    if (!cached) return { fetchedAt, windows: [], error: "Usage shows after this account is next used.", cached: false, resets: null };
    return { fetchedAt: cached.fetchedAt, windows: cached.windows, error: null, cached: true, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Copilot has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const { command, prefix } = await providerCommand("copilot");
    const env = spawnEnv(await this.env(home));
    // With a token variable set, `copilot login` would sign in with that token instead.
    for (const key of TOKEN_KEYS) delete env[key];
    const quiet = await quietOpenerDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new CopilotLogin(command, [...prefix, "login", "--device-code"], env);
  }

  /**
   * Copilot keeps sign-ins per GitHub user, not per home, so a removed account's keychain item is
   * deleted only when no other home still signs in as that user.
   */
  async logout(home: string): Promise<void> {
    const user = await copilotUser(home);
    if (!user || process.platform !== "darwin") return;
    const others = [mainCopilotHome()];
    for (const name of await readdir(homesDir()).catch(() => [] as string[])) {
      if (name.startsWith("copilot-") && join(homesDir(), name) !== home) others.push(join(homesDir(), name));
    }
    for (const other of others) {
      const theirs = await copilotUser(other);
      if (theirs && theirs.host === user.host && theirs.login.toLowerCase() === user.login.toLowerCase()) return;
    }
    for (const account of [`${user.host}:${user.login}`, `${user.host}:${user.login}:github`]) {
      await run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], { timeoutMs: 10_000 });
    }
  }

  detectLimit = detectCopilotLimit;
  detectSignOut = detectCopilotSignOut;

  environmentWarning(env: NodeJS.ProcessEnv): string | null {
    const set = TOKEN_KEYS.filter((key) => env[key]);
    return set.length > 0
      ? `The daemon's environment sets ${set.join(", ")}. Copilot agents on your CLI login use it; agents on added accounts run without it so their own sign-in applies, which also hides it from tools such as gh inside those agents.`
      : null;
  }
}

/** `copilot login --device-code`: prints a link and code, then waits until the code is approved. */
class CopilotLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const read = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const link = parseCopilotLogin(this.output);
      if (link && this.progress.step === "starting") this.update({ step: "waiting", url: link.url, userCode: link.code });
    };
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Copilot CLI: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0 && /Signed in successfully as/i.test(this.output)) return resolve({ ok: true, message: null });
        const last = this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: last ?? `copilot login exited with code ${code}` });
      });
    });
  }

  async submitCode(): Promise<void> {
    throw new Error("Copilot signs in on GitHub's page with the code shown here; there's nothing to paste back.");
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

/** "To authenticate, visit <url> and enter code <code>", as `copilot login --device-code` prints it. */
export function parseCopilotLogin(output: string): { url: string; code: string } | null {
  const match = output.match(/To authenticate, visit (https?:\/\/\S+) and enter code ([A-Z0-9-]{4,})/i);
  return match?.[1] && match[2] ? { url: match[1], code: match[2] } : null;
}
