import type { CombSpec, CombSpecInput } from "./types.js";
import { normalizeComb } from "./schema.js";

export function defineComb(spec: CombSpecInput): CombSpec {
  return normalizeComb(spec);
}

export * from "./types.js";
