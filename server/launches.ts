import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths";

/**
 * Agents the launcher (`bin/zerosub-claude`) started outside Paseo, one JSON line each, so launches
 * running at once only append. Routing counts them as recently placed agents, as it does its own, and
 * reads their accounts' usage as often as a busy account's: without them a burst of launches all
 * picks the same roomiest account on a reading that can't show them yet.
 */
export const launchesPath = (): string => join(dataDir(), "launches.jsonl");

/**
 * How long after a launch its account counts as busy, so its usage is read every minute: a gate
 * agent's step can run about 15 minutes and be tried once more. Pacing counts a launch for
 * `PENDING_MS` only, until a reading can show it.
 */
export const LAUNCH_BUSY_MS = 30 * 60_000;

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

/** A lock this old belongs to a launcher that died holding it; choosing and noting take milliseconds. */
export const LAUNCH_LOCK_STALE_MS = 5_000;
/** How long a launch waits for the lock before choosing without it, rather than hold up its caller. */
const LAUNCH_LOCK_WAIT_MS = 2_000;

/** Runs `fn` holding the launch log's lock file, so launches started at once choose one at a time. */
export async function withLaunchLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const until = Date.now() + LAUNCH_LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      held = true;
    } catch (error) {
      const waited = (error as NodeJS.ErrnoException).code === "EEXIST" && Date.now() < until;
      if (!waited) {
        console.error(`[ZeroSub] choosing without the launch lock (${lock}):`, error);
        break;
      }
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LAUNCH_LOCK_STALE_MS) await rm(lock, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lock, { force: true });
  }
}
