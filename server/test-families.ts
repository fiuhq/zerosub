import { FAMILIES, type Family } from "../shared/model";
import type { FamilyAdapter } from "./adapter";

/** Test helper: `base` for every family, with `own` adapters where a test needs them. */
export function everyFamily(base: FamilyAdapter, own: Partial<Record<Family, FamilyAdapter>> = {}): Record<Family, FamilyAdapter> {
  return Object.fromEntries(FAMILIES.map((family) => [family, own[family] ?? base])) as Record<Family, FamilyAdapter>;
}
