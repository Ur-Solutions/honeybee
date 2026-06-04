/**
 * Honeybee flow TS SDK — author-facing barrel.
 *
 * Flows written in TypeScript should import from here:
 *
 *   import { defineFlow } from "honeybee/flow";
 *
 *   export default defineFlow({
 *     name: "review",
 *     description: "Code review",
 *     args: [{ name: "target", default: "src" }],
 *     run: async (ctx) => {
 *       const arch = await ctx.hive.spawn({ bee: "claude" });
 *       await ctx.hive.brief(arch, `Review ${ctx.args.target}`);
 *       await ctx.hive.waitForSeal(arch);
 *     },
 *   });
 *
 * No runtime side-effects at import time: the runtime that supplies ctx.hive
 * lives in patches 11/12. Until then this file purely re-exports types and
 * the identity helper.
 */

export { defineFlow, validFlowName } from "./index.js";
export type {
  BeeHandle,
  Flow,
  FlowArg,
  FlowCleanup,
  FlowContext,
  FlowHive,
  FlowSpawnInput,
  FlowSpec,
} from "./index.js";
export { parseJsonFlow, substituteString } from "./json.js";
export type { CompiledStep, JsonFlow, JsonFlowOp, ParseOptions } from "./json.js";
