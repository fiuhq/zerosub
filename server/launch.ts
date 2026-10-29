// The account a tool Paseo doesn't launch (the no-mistakes gate's claude, a cron job) runs on: the one
// ZeroSub would give a brand-new agent right now. Same routing, preferences and usage readings as the
// service, read from disk, so the tool follows every switch, limit and default change ZeroSub makes.
// `bin/zerosub-claude` evaluates what this prints, then runs claude.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { type Family, FAMILY_PORTABLE, type Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import type { EnvPatch } from "./adapter";
import { ClaudeAdapter } from "./claude";
import { paseoHome } from "./paths";
import { chooseAccount, type EarlyLines } from "./routing";
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

/** The account a brand-new agent of `family` would open on now; null when ZeroSub has none. */
export function launchAccount(
  state: StoredState,
  readings: ReadonlyMap<string, Usage>,
  prefs: Preferences,
  family: Family,
  now: number,
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
    })?.account ?? null
  );
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
  const account = launchAccount(await new StateStore().read(), await loadReadings(), await readPreferences(), family, Date.now());
  if (!account) throw new Error("zerosub launch: ZeroSub has no Claude account to route to");
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
