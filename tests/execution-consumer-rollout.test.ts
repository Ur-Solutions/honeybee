import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APIARY_BUNDLE_IDENTIFIER,
  APIARY_DESIGNATED_REQUIREMENT,
  APIARY_TEAM_IDENTIFIER,
  assertExecutionConsumerAccepts,
  assertExecutionMaterializationMatches,
  parseExecutionConsumerRollout,
  preflightInstalledExecutionConsumer,
  verifyInstalledApiaryAppSignature,
  type ApiarySignatureVerifier,
  type CodeSignRunner,
  type ExecutionConsumerRollout,
  type ExecutionContractCandidate,
} from "../src/execution/consumerRollout.js";
import {
  EXECUTION_VALIDATION_SURFACE_VERSION,
  computeExecutionValidationSurfaceDigest,
  executionBaselineFeatures,
  loadExecutionContract,
} from "../src/execution/contract.js";

const surface = "sha256:" + "2".repeat(64);
const exactRevision = "1".repeat(40);
const compatibleRevision = "3".repeat(40);
const current: ExecutionContractCandidate = {
  contract: "honeybee-execution",
  contractVersion: "0.1.0",
  protocolVersion: "0.1",
  schemaDigest: "sha256:" + "1".repeat(64),
  validationSurfaceVersion: 1,
  validationSurfaceDigest: surface,
  sourceRevision: exactRevision,
  features: ["local-core-v1", "kit-profile-v1"],
};
const compatibleCandidate: ExecutionContractCandidate = {
  ...current,
  schemaDigest: "sha256:" + "3".repeat(64),
  sourceRevision: compatibleRevision,
  features: ["local-core-v1"],
};
const validSignature: ApiarySignatureVerifier = () => ({
  bundleIdentifier: APIARY_BUNDLE_IDENTIFIER,
  teamIdentifier: APIARY_TEAM_IDENTIFIER,
});

function certificate(): ExecutionConsumerRollout {
  return {
    schemaVersion: 1,
    consumer: {
      product: "apiary",
      contract: current.contract,
      contractVersion: current.contractVersion,
      protocolVersion: current.protocolVersion,
      pinnedSchemaDigest: current.schemaDigest,
      validationSurfaceVersion: 1,
      validationSurfaceDigest: surface,
    },
    acceptedServerContracts: [
      {
        schemaDigest: current.schemaDigest,
        sourceRevision: exactRevision,
        mode: "exact",
        validationSurfaceVersion: 1,
        validationSurfaceDigest: surface,
        features: ["local-core-v1", "kit-profile-v1"],
      },
      {
        schemaDigest: compatibleCandidate.schemaDigest,
        sourceRevision: compatibleRevision,
        mode: "validation-compatible",
        validationSurfaceVersion: 1,
        validationSurfaceDigest: surface,
        features: ["local-core-v1"],
        reason: "same validation surface",
      },
    ],
  };
}

test("canonical execution validation surface matches the reviewed Apiary certificate", () => {
  const contract = loadExecutionContract();
  assert.equal(EXECUTION_VALIDATION_SURFACE_VERSION, 1);
  assert.equal(
    computeExecutionValidationSurfaceDigest(contract),
    "sha256:423714315c8c2e704424acf56ce0783e1cea2018a9a3978e6773bdeadeacb6db",
  );
  assert.deepEqual(executionBaselineFeatures(contract), ["local-core-v1", "kit-profile-v1"]);
});

test("consumer rollout accepts only the exact certified candidate identity", () => {
  const rollout = parseExecutionConsumerRollout(certificate());
  assert.equal(assertExecutionConsumerAccepts(rollout, current), "exact");
  assert.equal(assertExecutionConsumerAccepts(rollout, compatibleCandidate), "validation-compatible");
  assert.throws(
    () =>
      assertExecutionConsumerAccepts(rollout, {
        ...current,
        schemaDigest: "sha256:" + "4".repeat(64),
        sourceRevision: "4".repeat(40),
      }),
    /does not accept Honeybee execution digest/,
  );
});

test("candidate surface, source revision, and feature ceiling are all deploy fences", () => {
  const rollout = parseExecutionConsumerRollout(certificate());
  assert.throws(
    () =>
      assertExecutionConsumerAccepts(rollout, {
        ...compatibleCandidate,
        validationSurfaceDigest: "sha256:" + "9".repeat(64),
      }),
    /does not accept Honeybee validation surface/,
  );
  assert.throws(
    () => assertExecutionConsumerAccepts(rollout, { ...compatibleCandidate, sourceRevision: "4".repeat(40) }),
    /certified Honeybee execution source revision/,
  );
  assert.throws(
    () =>
      assertExecutionConsumerAccepts(rollout, {
        ...compatibleCandidate,
        features: ["local-core-v1", "kit-profile-v1"],
      }),
    /features outside.*certificate/,
  );
});

test("post-install materialization rejects stale corpus, surface, or feature bytes", () => {
  assert.doesNotThrow(() => assertExecutionMaterializationMatches(current, current));
  assert.throws(
    () =>
      assertExecutionMaterializationMatches(current, {
        ...current,
        schemaDigest: "sha256:" + "8".repeat(64),
      }),
    /does not equal the signed, preflighted candidate/,
  );
  assert.throws(
    () =>
      assertExecutionMaterializationMatches(current, {
        ...current,
        validationSurfaceDigest: "sha256:" + "9".repeat(64),
      }),
    /does not equal the signed, preflighted candidate/,
  );
  assert.throws(
    () => assertExecutionMaterializationMatches(current, { ...current, features: ["local-core-v1"] }),
    /does not equal the signed, preflighted candidate/,
  );
});

test("consumer rollout refuses forged surfaces, incomplete exact records, and duplicate digests", () => {
  const wrongSurface = certificate();
  wrongSurface.acceptedServerContracts[1] = {
    ...wrongSurface.acceptedServerContracts[1]!,
    validationSurfaceDigest: "sha256:" + "9".repeat(64),
  };
  assert.throws(() => parseExecutionConsumerRollout(wrongSurface), /different validation surface/);

  const incompleteExact = structuredClone(certificate()) as unknown as {
    acceptedServerContracts: Array<Record<string, unknown>>;
  };
  delete incompleteExact.acceptedServerContracts[0]!.features;
  assert.throws(() => parseExecutionConsumerRollout(incompleteExact), /features must be/);

  const duplicate = certificate();
  duplicate.acceptedServerContracts[1] = {
    ...duplicate.acceptedServerContracts[1]!,
    schemaDigest: current.schemaDigest,
  };
  assert.throws(() => parseExecutionConsumerRollout(duplicate), /duplicate accepted server digest/);
});

test("codesign verifier pins Apiary's designated requirement, identifier, and team", () => {
  const calls: string[][] = [];
  const runner: CodeSignRunner = (args) => {
    calls.push([...args]);
    if (args.includes("--verify")) return { status: 0, stdout: "", stderr: "" };
    return {
      status: 0,
      stdout: "",
      stderr: `Executable=/Applications/Apiary.app/Contents/MacOS/Apiary
Identifier=${APIARY_BUNDLE_IDENTIFIER}
TeamIdentifier=${APIARY_TEAM_IDENTIFIER}
`,
    };
  };
  assert.deepEqual(verifyInstalledApiaryAppSignature("/Applications/Apiary.app", runner), {
    bundleIdentifier: APIARY_BUNDLE_IDENTIFIER,
    teamIdentifier: APIARY_TEAM_IDENTIFIER,
  });
  assert.deepEqual(calls[0], [
    "--verify",
    "--deep",
    "--strict",
    "--test-requirement",
    APIARY_DESIGNATED_REQUIREMENT,
    "/Applications/Apiary.app",
  ]);
  assert.deepEqual(calls[1], ["--display", "--verbose=4", "/Applications/Apiary.app"]);

  const wrongTeam: CodeSignRunner = (args) =>
    args.includes("--verify")
      ? { status: 0, stdout: "", stderr: "" }
      : {
          status: 0,
          stdout: "",
          stderr: `Identifier=${APIARY_BUNDLE_IDENTIFIER}\nTeamIdentifier=ATTACKER\n`,
        };
  assert.throws(
    () => verifyInstalledApiaryAppSignature("/Applications/Apiary.app", wrongTeam),
    /expected com\.trmd\.apiary\/4QK8JBAU4V/,
  );
});

test(
  "codesign requirement syntax accepts the real installed Apiary bundle",
  { skip: process.platform !== "darwin" || !existsSync("/Applications/Apiary.app") },
  () => {
    assert.deepEqual(verifyInstalledApiaryAppSignature("/Applications/Apiary.app"), {
      bundleIdentifier: APIARY_BUNDLE_IDENTIFIER,
      teamIdentifier: APIARY_TEAM_IDENTIFIER,
    });
  },
);

test("installed-app preflight verifies the app before trusting its certificate", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-consumer-preflight."));
  const app = join(root, "Apiary.app");
  mkdirSync(app);
  assert.throws(
    () => preflightInstalledExecutionConsumer(current, { appBundlePath: app, verifyAppSignature: validSignature }),
    /has no execution contract consumer certificate/,
  );

  const manifest = join(app, "Contents", "Resources", "execution-contract-consumer.json");
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(manifest, JSON.stringify(certificate()));
  assert.deepEqual(
    preflightInstalledExecutionConsumer(current, { appBundlePath: app, verifyAppSignature: validSignature }),
    {
      kind: "accepted",
      manifestPath: manifest,
      product: "apiary",
      mode: "exact",
    },
  );
  assert.throws(
    () =>
      preflightInstalledExecutionConsumer(
        { ...current, schemaDigest: "sha256:" + "8".repeat(64), sourceRevision: "8".repeat(40) },
        { appBundlePath: app, verifyAppSignature: validSignature },
      ),
    /promote an Apiary build/,
  );

  writeFileSync(manifest, "{not-json");
  assert.throws(
    () =>
      preflightInstalledExecutionConsumer(current, {
        appBundlePath: app,
        verifyAppSignature: () => {
          throw new Error("signature rejected");
        },
      }),
    /signature rejected/,
    "signature rejection happens before certificate bytes are parsed",
  );
});

test("any explicit missing Apiary bundle override fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-consumer-missing-override."));
  assert.throws(
    () =>
      preflightInstalledExecutionConsumer(current, {
        appBundlePath: join(root, "missing.app"),
        verifyAppSignature: validSignature,
      }),
    /explicit Apiary app bundle does not exist.*refusing Honeybee deploy/,
  );
  assert.throws(
    () => preflightInstalledExecutionConsumer(current, { appBundlePath: "", verifyAppSignature: validSignature }),
    /explicit Apiary app bundle does not exist.*refusing Honeybee deploy/,
  );
});
