import { FAMILIES, type Family } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { absentPi } from "./fakes.test-support";

/**
 * Test helper: `base` for every family, with `own` adapters where a test needs them. Pi, whose added
 * accounts are API keys rather than subscriptions, gets `absentPi` unless a test gives it one.
 */
export function everyFamily(base: FamilyAdapter, own: Partial<Record<Family, FamilyAdapter>> = {}): Record<Family, FamilyAdapter> {
  return Object.fromEntries(FAMILIES.map((family) => [family, own[family] ?? (family === "pi" ? absentPi() : base)])) as Record<Family, FamilyAdapter>;
}
