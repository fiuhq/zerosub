import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";

/**
 * Agents the launcher (`bin/zerosub-claude`) started outside Paseo, one JSON line each, so launches
 * running at once only append. Routing counts them as recently placed agents, as it does its own, and
 * reads their accounts' usage as often as a busy account's: without them a burst of launches all
 * picks the same roomiest account on a reading that can't show them yet.
 */
export const launchesPath = (): string => join(dataDir(), "launches.jsonl");

/** Past this size the log starts over beside its old copy. */
export const LAUNCH_LOG_MAX_BYTES = 1_000_000;

export async function noteLaunch(accountId: string, at: number, path = launchesPath()): Promise<void> {
  const size = await stat(path).then((info) => info.size, () => 0);
  // ponytail: two launches rotating at once can drop a line; it's only a pacing hint, so no lock.
  if (size > LAUNCH_LOG_MAX_BYTES) await rename(path, `${path}.1`).catch(() => undefined);
  await appendFile(path, `${JSON.stringify({ accountId, at })}\n`);
}

/** How many launches each account took after `since`. A missing log or a torn line counts as none. */
export async function launchesSince(since: number, path = launchesPath()): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    let entry: { accountId?: unknown; at?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.accountId === "string" && typeof entry.at === "number" && entry.at > since) {
      counts.set(entry.accountId, (counts.get(entry.accountId) ?? 0) + 1);
    }
  }
  return counts;
}
