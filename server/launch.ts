// The account a tool Paseo doesn't launch (the no-mistakes gate's claude, a cron job) runs on: the one
// ZeroSub would give a brand-new agent right now. Same routing, preferences and usage readings as the
// service, read from disk, so the tool follows every switch, limit and default change ZeroSub makes.
// `bin/zerosub-claude` evaluates what this prints, then runs claude.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { type Family, FAMILY_PORTABLE, type Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import type { EnvPatch } from "./adapter";
import { ClaudeAdapter } from "./claude";
import { paseoHome, statePath } from "./paths";
import { launchesSince, noteLaunch } from "./launches";
import { chooseAccount, PENDING_MS, type EarlyLines } from "./routing";
import { StateStore, type StoredAccount, type StoredState } from "./state";
import { loadReadings } from "./usage";

type Preferences = z.infer<typeof preferences.schema>;

/** Never bound to an account, so it always routes as a brand-new agent. */
const OUTSIDE_AGENT = "zerosub-launch";

/** Switch early's lines, as the service draws them: null when switching or switch early is off. */
export function earlyLines(prefs: Preferences): EarlyLines | null {
  const lines = { short: prefs.switchEarlyAt, long: prefs.switchEarlyWeeklyAt };
  return prefs.autoSwitch && (lines.short < 100 || lines.long < 100) ? lines : null;
}

/**
 * The account a brand-new agent of `family` would open on now; null when ZeroSub has none. `launched`
 * counts each account's recent launches, which its reading can't show yet (see `launchesSince`).
 */
export function launchAccount(
  state: StoredState,
  readings: ReadonlyMap<string, Usage>,
  prefs: Preferences,
  family: Family,
  now: number,
  launched: ReadonlyMap<string, number> = new Map(),
): StoredAccount | null {
  return (
    chooseAccount(state, {
      agentId: OUTSIDE_AGENT,
      family,
      reason: "create",
      now,
      projectId: null,
      autoSwitch: prefs.autoSwitch,
      balanceNewAgents: prefs.balanceNewAgents,
      portable: FAMILY_PORTABLE[family],
      usageOf: (id) => readings.get(id),
      early: earlyLines(prefs),
      pendingOf: (id) => launched.get(id) ?? 0,
    })?.account ?? null
  );
}

/** state.json as it is on disk now: a store caches its first read, so each read opens a new one. */
export const readState = (path: string) => () => new StateStore(path, { readOnly: true }).read();

/**
 * The account once its home has stopped moving: no move of it on record and its folder on disk,
 * re-read from `read` after each `pause` for up to `attempts` reads. Throws when it never settles.
 */
export async function settledAccount(
  state: StoredState,
  id: string,
  read: () => Promise<StoredState>,
  { attempts = 60, pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)) }: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<StoredAccount> {
  for (let left = attempts; ; left -= 1) {
    const account = state.accounts.find((candidate) => candidate.id === id);
    const move = state.moves[id];
    if (account && !move && (!account.home || existsSync(account.home))) return account;
    if (left <= 1) {
      const why = !account ? "is no longer in ZeroSub" : move ? `is still moving from ${move.from} to ${move.to}` : `has no home at ${account.home}`;
      throw new Error(`zerosub launch: account ${account?.label ?? id} ${why}`);
    }
    await pause();
    state = await read();
  }
}

/** An env patch as POSIX shell: `export K='v'` to set, `unset K` to clear. */
export function shellExports(patch: EnvPatch): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return Object.entries(patch)
    .map(([key, value]) => (value === null ? `unset ${key}` : `export ${key}=${quote(value)}`))
    .join("\n");
}

async function readPreferences(): Promise<Preferences> {
  const file = join(paseoHome(), "plugin-settings", "zerosub", `${preferences.id}.json`);
  const saved = await readFile(file, "utf8").then((text) => JSON.parse(text) as { values?: unknown }, () => ({ values: {} }));
  return preferences.schema.parse(saved.values ?? {});
}

async function main(): Promise<void> {
  const family = (process.argv[2] ?? "claude") as Family;
  if (family !== "claude") throw new Error(`zerosub launch: only claude is supported, got ${family}`);
  const read = readState(statePath());
  const state = await read();
  const now = Date.now();
  const chosen = launchAccount(state, await loadReadings(), await readPreferences(), family, now, await launchesSince(now - PENDING_MS));
  if (!chosen) throw new Error("zerosub launch: ZeroSub has no Claude account to route to");
  // Noted at once, before any wait, so a launch right behind this one sees it. Only a pacing hint for
  // the next launches: one that can't be noted still launches, and says so.
  // ponytail: launches within the same few milliseconds can still both pick one account; a lock around
  // read, choose and note would close that, if bursts ever land that tightly.
  await noteLaunch(chosen.id, now).catch((error: unknown) => console.error(`[ZeroSub] could not note the launch on ${chosen.label}:`, error));
  const account = await settledAccount(state, chosen.id, read);
  // Said on stderr so the caller's log names the account; stdout is only the env to apply.
  console.error(`[ZeroSub] launch → ${account.label}`);
  console.log(shellExports(await new ClaudeAdapter().env(account.home)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
