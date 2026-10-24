import { describe, expect, it } from "vitest";
import { FALLBACK_ORDER, FAMILIES, FAMILY_CLI, FAMILY_HEADING, FAMILY_LABEL, FAMILY_PORTABLE, FAMILY_SIGN_IN, fallbackFamilies } from "./model";
import { MAIN_ACCOUNT_ID, salvageState } from "../server/state";

describe("families", () => {
  it("give every family a row in each table and a place in the fallback order", () => {
    for (const table of [FAMILY_LABEL, FAMILY_HEADING, FAMILY_CLI, FAMILY_PORTABLE, FAMILY_SIGN_IN]) {
      expect(Object.keys(table).sort()).toEqual([...FAMILIES].sort());
    }
    expect([...FALLBACK_ORDER].sort()).toEqual([...FAMILIES].sort());
  });

  it("fall back to every other family, most preferred first", () => {
    expect(fallbackFamilies("claude")).toEqual(["codex"]);
    expect(fallbackFamilies("codex")).toEqual(["claude"]);
  });

  it("keep the CLI login ids and read the older two-family defaults", () => {
    expect(MAIN_ACCOUNT_ID).toEqual({ claude: "claude-main", codex: "codex-main" });
    const { state, dropped } = salvageState({ version: 1, defaults: { claude: "claude-a", codex: null } });
    expect(dropped).toBe(false);
    expect(state.defaults).toEqual({ claude: "claude-a", codex: null });
  });
});
