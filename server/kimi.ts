import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
import { prepareKimiHome } from "./homes";
import { detectKimiLimit, detectKimiSignOut } from "./limits";
import { mainKimiHome } from "./paths";
import { run, stripAnsi } from "./process";

/** Kimi Code's managed API, by sign-in region (the CLI's own `KIMI_REGION_PROFILES`). */
const REGION_BASE: Record<KimiRegion, string> = {
  "mainland-cn": "https://api.kimi.com/coding/v1",
  global: "https://api.kimi.ai/coding/v1",
};
const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";

export type KimiRegion = "mainland-cn" | "global";

/** What a Kimi Code home says about its sign-in: the token's file name and the region it belongs to. */
export interface KimiSignIn {
  /** `credentials/<name>.json`. */
  name: string;
  region: KimiRegion;
}

/**
 * Reads a home's sign-in the way the CLI resolves it: `config.toml`'s managed OAuth reference
 * (`key = "oauth/<name>"`, plus `oauth_host` for a global login), else the install-channel `region`
 * marker, else mainland China, the CLI's default slot.
 */
export async function readKimiSignIn(home: string): Promise<KimiSignIn> {
  const config = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
  const name = config.match(/^\s*key\s*=\s*"oauth\/([^"/]+)"/m)?.[1] ?? "kimi-code";
  const host = config.match(/^\s*oauth_host\s*=\s*"([^"]+)"/m)?.[1]?.replace(/\/+$/, "");
  const marker = (await readFile(join(home, "region"), "utf8").catch(() => "")).trim();
  const region: KimiRegion = host ? (host === GLOBAL_OAUTH_HOST ? "global" : "mainland-cn") : marker === "global" ? "global" : "mainland-cn";
  return { name, region };
}

export function kimiBaseUrl(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return (env.KIMI_CODE_BASE_URL?.trim() || REGION_BASE[region]).replace(/\/+$/, "");
}

interface KimiToken {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch seconds. */
  expiresAt: number;
}

/** The stored token for a sign-in, read only: the CLI does every refresh itself. */
export async function readKimiToken(home: string, name: string): Promise<KimiToken | null> {
  try {
    const raw = JSON.parse(await readFile(join(home, "credentials", `${name}.json`), "utf8")) as Record<string, unknown>;
    if (typeof raw.access_token !== "string") return null;
    return {
      accessToken: raw.access_token,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
      expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : 0,
    };
  } catch {
    // Missing or half-written.
    return null;
  }
}

function isFresh(token: KimiToken | null, now = Date.now()): token is KimiToken {
  return Boolean(token) && token!.expiresAt * 1000 > now + 30_000;
}

/** The user ID inside the access token, so an account is recognised even while its token is stale. */
function tokenUser(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.user_id === "string" ? payload.user_id : typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The plan windows `/usages` reports, by the CLI's own names. */
const WINDOWS: ReadonlyArray<{ key: string; id: string; label: string }> = [
  { key: "limit_5h", id: "five_hour", label: "5-hour" },
  { key: "limit_7d", id: "seven_day", label: "Weekly" },
  { key: "limit_month_total", id: "month", label: "Monthly" },
  { key: "limit_month_code", id: "month_code", label: "Monthly · coding" },
];

export function parseKimiUsage(body: unknown): UsageWindow[] {
  const usages = body && typeof body === "object" ? (body as Record<string, unknown>).usages : undefined;
  if (!usages || typeof usages !== "object") return [];
  const windows: UsageWindow[] = [];
  for (const { key, id, label } of WINDOWS) {
    const entry = (usages as Record<string, unknown>)[key] as { used_ratio?: unknown; reset_time?: unknown } | undefined;
    const ratio = typeof entry?.used_ratio === "number" ? entry.used_ratio : Number(entry?.used_ratio);
    if (!entry || !Number.isFinite(ratio)) continue;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, ratio * 100)),
      resetsAt: typeof entry.reset_time === "string" && entry.reset_time ? entry.reset_time : null,
    });
  }
  return windows;
}

async function getJson(url: string, token: string): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: await response.json() };
}

const SIGNED_OUT: Identity = { signedIn: false, email: null, plan: null, organization: null, identity: null };

export class KimiAdapter implements FamilyAdapter {
  readonly family = "kimi" as const;
  /** Sessions live in the shared folder, and nothing in them is tied to one account. */
  readonly portable = FAMILY_PORTABLE.kimi;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    return { KIMI_CODE_HOME: home };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("kimi");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareKimiHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const root = home ?? mainKimiHome();
    const signIn = await readKimiSignIn(root);
    const token = await readKimiToken(root, signIn.name);
    if (!token?.refreshToken) return SIGNED_OUT;
    let user = tokenUser(token.accessToken);
    let email: string | null = null;
    let plan: string | null = null;
    if (isFresh(token)) {
      const me = await getJson(`${kimiBaseUrl(signIn.region)}/me`, token.accessToken).catch(() => null);
      if (me?.ok && me.body && typeof me.body === "object") {
        const body = me.body as Record<string, unknown>;
        user = typeof body.user_id === "string" ? body.user_id : user;
        email = [body.email, body.nickname].find((value): value is string => typeof value === "string" && value !== "") ?? null;
        plan = typeof body.user_level_name === "string" && body.user_level_name ? body.user_level_name : null;
      }
    }
    return { signedIn: true, email, plan, organization: null, identity: user ? `kimi|${user}` : null };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const root = home ?? mainKimiHome();
    const signIn = await readKimiSignIn(root);
    const token = await readKimiToken(root, signIn.name);
    if (!isFresh(token)) {
      return { fetchedAt, windows: [], error: "Usage shows after this account is next used.", cached: false, resets: null };
    }
    try {
      const reply = await getJson(`${kimiBaseUrl(signIn.region)}/usages`, token.accessToken);
      if (!reply.ok) return { fetchedAt, windows: [], error: `Usage request failed (HTTP ${reply.status})`, cached: false, resets: null };
      return { fetchedAt, windows: parseKimiUsage(reply.body), error: null, cached: false, resets: null };
    } catch (error) {
      return { fetchedAt, windows: [], error: error instanceof Error ? error.message : String(error), cached: false, resets: null };
    }
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Kimi Code has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const { command, prefix } = await providerCommand("kimi");
    const env = spawnEnv(await this.env(home));
    // The link and code show in Paseo, so `kimi login` mustn't open a browser on the daemon's machine.
    const quiet = await quietOpenerDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new KimiLogin(command, [...prefix, "login"], env);
  }

  async logout(_home: string): Promise<void> {
    // The sign-in lives in the home itself, which is deleted next.
  }

  detectLimit = detectKimiLimit;
  detectSignOut = detectKimiSignOut;

  environmentWarning(env: NodeJS.ProcessEnv): string | null {
    return env.KIMI_CODE_HOME || env.KIMI_CODE_BASE_URL
      ? "The daemon's environment sets KIMI_CODE_HOME or KIMI_CODE_BASE_URL. Kimi agents on your CLI login use that; agents on added accounts use their own sign-in."
      : null;
  }
}

/** `kimi login`: prints a device-code link and code, then waits until the code is approved. */
class KimiLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const read = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const link = parseKimiLogin(this.output);
      if (link && this.progress.step === "starting") this.update({ step: "waiting", url: link.url, userCode: link.code });
    };
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Kimi Code: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return resolve({ ok: true, message: null });
        const last = this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: last ?? `kimi login exited with code ${code}` });
      });
    });
  }

  async submitCode(): Promise<void> {
    throw new Error("Kimi signs in on its own page with the code shown here; there's nothing to paste back.");
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

/**
 * The link and code from `kimi login`'s output: "Opening browser for Kimi device login: <url>" and
 * "… paste the URL above and enter code: <code>". The link usually carries the code too.
 */
export function parseKimiLogin(output: string): { url: string; code: string | null } | null {
  const url = output.match(/device login:\s*(https:\/\/\S+)/i)?.[1];
  if (!url) return null;
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(url).searchParams.get("user_code");
  } catch {
    // Not a parseable URL; the printed code still works.
  }
  const code = output.match(/enter code:\s*([A-Za-z0-9-]{4,})/i)?.[1] ?? fromUrl;
  return { url, code };
}
