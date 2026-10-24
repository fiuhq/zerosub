import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "./process";

const NODE = process.execPath;
const MIB = 1024 * 1024;

describe("run", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await run(NODE, ["-e", 'process.stdout.write("out\\n"); process.stderr.write("err\\n");'], {
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const result = await run(NODE, ["-e", 'process.stdout.write("€".repeat(100000))'], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("€".repeat(100000));
  });

  it("times out a hanging child", async () => {
    const result = await run(NODE, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it.skipIf(process.platform === "win32")("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // The child marks when its SIGTERM handler is live and when SIGTERM arrives; fake timers start the
    // timeout only after the first mark, so a slow Node startup cannot let SIGTERM kill it outright.
    const dir = mkdtempSync(join(tmpdir(), "run-sigkill-"));
    const ready = join(dir, "ready");
    const term = join(dir, "term");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = run(
        NODE,
        [
          "-e",
          `const fs = require("fs"); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(term)}, "")); ` +
            `fs.writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1_000);`,
        ],
        { timeoutMs: 200 },
      ).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
      vi.advanceTimersByTime(200);
      await vi.waitFor(() => expect(existsSync(term)).toBe(true), { timeout: 10_000 });
      // SIGTERM was ignored, so only the 2 s SIGKILL escalation can end the child.
      expect(settled).toBe(false);
      vi.advanceTimersByTime(2_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("caps output past 1 MiB and reports the limit first", async () => {
    const result = await run(
      NODE,
      ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stderr.write("late\\n");'],
      { timeoutMs: 10_000 },
    );
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.split("\n")[0]).toBe("Command output exceeded the 1 MiB limit.");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MIB);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(MIB - 8);
  });

  it.skipIf(process.platform === "win32")("reports the output limit, not a timeout, when a spewing child ignores SIGTERM", async () => {
    const result = await run(
      NODE,
      [
        "-e",
        'process.on("SIGTERM", () => {}); const s = "z".repeat(65536); ' +
          "for (let i = 0; i < 40; i++) process.stdout.write(s); " +
          "setInterval(() => process.stdout.write(s), 100); setTimeout(() => {}, 30_000);",
      ],
      { timeoutMs: 300 },
    );
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.split("\n")[0]).toBe("Command output exceeded the 1 MiB limit.");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MIB);
  }, 15_000);
});
