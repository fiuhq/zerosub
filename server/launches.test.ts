import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_LOCK_STALE_MS, LAUNCH_LOG_MAX_BYTES, launchesSince, noteLaunch, withLaunchLock } from "./launches";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const logFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "zerosub-launches-"));
  dirs.push(dir);
  return join(dir, "launches.jsonl");
};

describe("the launch log", () => {
  it("counts each account's launches after a time, skipping a torn line", async () => {
    const file = logFile();
    await noteLaunch("a", 1_000, file);
    await noteLaunch("a", 2_000, file);
    await noteLaunch("b", 3_000, file);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"accountId":"a","at":`);
    expect(await launchesSince(1_500, file)).toEqual(new Map([["a", 1], ["b", 1]]));
  });

  it("reads no launches from a log that isn't there", async () => {
    expect(await launchesSince(0, logFile())).toEqual(new Map());
  });

  it("keeps every launch when many are noted at once", async () => {
    const file = logFile();
    await Promise.all(Array.from({ length: 50 }, (_, i) => noteLaunch("a", i + 1, file)));
    expect((await launchesSince(0, file)).get("a")).toBe(50);
  });

  it("starts over past its size cap, keeping the old log beside it", async () => {
    const file = logFile();
    writeFileSync(file, `${JSON.stringify({ accountId: "old", at: 1 })}\n`.repeat(Math.ceil(LAUNCH_LOG_MAX_BYTES / 20)));
    await noteLaunch("a", 5, file);
    expect(await launchesSince(0, file)).toEqual(new Map([["a", 1]]));
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});

describe("the launch lock", () => {
  it("runs one holder at a time and lets go after each", async () => {
    const file = logFile();
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withLaunchLock(file, async () => {
          most = Math.max(most, (inside += 1));
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("takes over a lock a launcher died holding", async () => {
    const file = logFile();
    writeFileSync(`${file}.lock`, "12345");
    const old = (Date.now() - LAUNCH_LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    const started = Date.now();
    expect(await withLaunchLock(file, async () => "ran")).toBe("ran");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
