// Public entrypoint for the execution protocol contract (package subpath
// `honeybee/execution/v1`). Everything Apiary needs to consume the corpus
// without copying source: loader, validators, digest, state machines, and the
// conformance runner both repositories must pass with the same digest.
export {
  EXECUTION_CONTRACT_SCHEMA_ID_BASE,
  computeSchemaDigest,
  createExecutionValidator,
  executionContractRoot,
  isTransitionAllowed,
  loadExecutionContract,
  stateMachine,
  type ExecutionContract,
  type ExecutionFixture,
  type ExecutionValidator,
  type JsonObject,
  type NegotiationFixture,
  type StateMachine,
  type TransitionFixture,
  type ValidationResult,
} from "./contract.js";
export { runConformance, type ConformanceIssue, type ConformanceReport } from "./conformance.js";
