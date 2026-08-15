import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;

export const APIARY_BUNDLE_IDENTIFIER = "com.trmd.apiary";
export const APIARY_TEAM_IDENTIFIER = "4QK8JBAU4V";
export const APIARY_DESIGNATED_REQUIREMENT =
  `=identifier "${APIARY_BUNDLE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${APIARY_TEAM_IDENTIFIER}"`;

export type ExecutionContractIdentity = {
  contract: string;
  contractVersion: string;
  protocolVersion: string;
  schemaDigest: string;
};

/**
 * Identity of the exact candidate corpus a deploy is about to activate.
 * Unlike a hello response, this includes locally computed compatibility
 * evidence and the Git revision that owns those bytes.
 */
export type ExecutionContractCandidate = ExecutionContractIdentity & {
  validationSurfaceVersion: 1;
  validationSurfaceDigest: string;
  sourceRevision: string;
  features: string[];
};

export type ExecutionConsumerRollout = {
  schemaVersion: 1;
  consumer: {
    product: string;
    contract: string;
    contractVersion: string;
    protocolVersion: string;
    pinnedSchemaDigest: string;
    validationSurfaceVersion: 1;
    validationSurfaceDigest: string;
  };
  acceptedServerContracts: Array<{
    schemaDigest: string;
    /** Last Git commit that changed contracts/execution/v1 for this digest. */
    sourceRevision: string;
    mode: "exact" | "validation-compatible";
    validationSurfaceVersion: 1;
    validationSurfaceDigest: string;
    /** Maximum set this server corpus may advertise during negotiation. */
    features: string[];
    reason?: string;
  }>;
};

export type ConsumerPreflightResult =
  | { kind: "standalone"; detail: string }
  | { kind: "accepted"; manifestPath: string; product: string; mode: "exact" | "validation-compatible" };

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function featureList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((feature) => typeof feature !== "string" || feature.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be a non-empty array of unique strings`);
  }
  return [...value] as string[];
}

/**
 * Parse the consumer's signed rollout certificate. Honeybee does not infer
 * compatibility: only an explicit exact or validation-compatible record in
 * the installed Apiary build authorizes activation of a daemon digest.
 */
export function parseExecutionConsumerRollout(value: unknown): ExecutionConsumerRollout {
  const root = object(value, "execution consumer certificate");
  if (root.schemaVersion !== 1) throw new Error("execution consumer certificate schemaVersion must be 1");
  const rawConsumer = object(root.consumer, "execution consumer certificate.consumer");
  if (rawConsumer.validationSurfaceVersion !== 1) {
    throw new Error("consumer.validationSurfaceVersion must be 1");
  }
  const consumer = {
    product: string(rawConsumer.product, "consumer.product"),
    contract: string(rawConsumer.contract, "consumer.contract"),
    contractVersion: string(rawConsumer.contractVersion, "consumer.contractVersion"),
    protocolVersion: string(rawConsumer.protocolVersion, "consumer.protocolVersion"),
    pinnedSchemaDigest: string(rawConsumer.pinnedSchemaDigest, "consumer.pinnedSchemaDigest"),
    validationSurfaceVersion: 1 as const,
    validationSurfaceDigest: string(rawConsumer.validationSurfaceDigest, "consumer.validationSurfaceDigest"),
  };
  if (!SHA256_DIGEST.test(consumer.pinnedSchemaDigest) || !SHA256_DIGEST.test(consumer.validationSurfaceDigest)) {
    throw new Error("execution consumer certificate contains an invalid consumer digest");
  }
  if (!Array.isArray(root.acceptedServerContracts) || root.acceptedServerContracts.length === 0) {
    throw new Error("execution consumer certificate must accept at least one server contract");
  }
  const seen = new Set<string>();
  let exact = 0;
  const acceptedServerContracts = root.acceptedServerContracts.map((entry, index) => {
    const label = `acceptedServerContracts[${index}]`;
    const record = object(entry, label);
    const schemaDigest = string(record.schemaDigest, `${label}.schemaDigest`);
    const sourceRevision = string(record.sourceRevision, `${label}.sourceRevision`);
    const mode = string(record.mode, `${label}.mode`);
    if (record.validationSurfaceVersion !== 1) {
      throw new Error(`${label}.validationSurfaceVersion must be 1`);
    }
    const validationSurfaceDigest = string(record.validationSurfaceDigest, `${label}.validationSurfaceDigest`);
    const features = featureList(record.features, `${label}.features`);
    if (!SHA256_DIGEST.test(schemaDigest) || !GIT_REVISION.test(sourceRevision)) {
      throw new Error(`${label} contains an invalid digest or source revision`);
    }
    if (validationSurfaceDigest !== consumer.validationSurfaceDigest) {
      throw new Error(`${mode} server digest ${schemaDigest} has a different validation surface`);
    }
    if (seen.has(schemaDigest)) throw new Error(`duplicate accepted server digest ${schemaDigest}`);
    seen.add(schemaDigest);
    if (mode === "exact") {
      exact += 1;
      if (schemaDigest !== consumer.pinnedSchemaDigest) {
        throw new Error(`exact server digest ${schemaDigest} does not equal consumer pin`);
      }
      return {
        schemaDigest,
        sourceRevision,
        mode: "exact" as const,
        validationSurfaceVersion: 1 as const,
        validationSurfaceDigest,
        features,
      };
    }
    if (mode !== "validation-compatible") throw new Error(`${label}.mode is unsupported`);
    const reason = string(record.reason, `${label}.reason`);
    return {
      schemaDigest,
      sourceRevision,
      mode: "validation-compatible" as const,
      validationSurfaceVersion: 1 as const,
      validationSurfaceDigest,
      features,
      reason,
    };
  });
  if (exact !== 1) throw new Error(`execution consumer certificate must contain exactly one exact digest; found ${exact}`);
  return { schemaVersion: 1, consumer, acceptedServerContracts };
}

export function assertExecutionConsumerAccepts(
  rollout: ExecutionConsumerRollout,
  candidate: ExecutionContractCandidate,
): "exact" | "validation-compatible" {
  for (const field of ["contract", "contractVersion", "protocolVersion"] as const) {
    if (rollout.consumer[field] !== candidate[field]) {
      throw new Error(
        `installed ${rollout.consumer.product} expects ${field}=${rollout.consumer[field]}, ` +
          `but this Honeybee build provides ${candidate[field]}`,
      );
    }
  }
  if (
    candidate.validationSurfaceVersion !== rollout.consumer.validationSurfaceVersion ||
    !SHA256_DIGEST.test(candidate.validationSurfaceDigest) ||
    candidate.validationSurfaceDigest !== rollout.consumer.validationSurfaceDigest
  ) {
    throw new Error(
      `installed ${rollout.consumer.product} does not accept Honeybee validation surface ` +
        `v${candidate.validationSurfaceVersion} ${candidate.validationSurfaceDigest}`,
    );
  }
  if (!GIT_REVISION.test(candidate.sourceRevision)) {
    throw new Error(`Honeybee execution source revision ${candidate.sourceRevision} is invalid`);
  }
  const candidateFeatures = featureList(candidate.features, "Honeybee execution candidate features");
  const accepted = rollout.acceptedServerContracts.find((record) => record.schemaDigest === candidate.schemaDigest);
  if (accepted === undefined) {
    throw new Error(
      `installed ${rollout.consumer.product} does not accept Honeybee execution digest ${candidate.schemaDigest}; ` +
        `promote an Apiary build carrying an exact or validation-compatible certificate before deploying Honeybee`,
    );
  }
  if (accepted.sourceRevision !== candidate.sourceRevision) {
    throw new Error(
      `installed ${rollout.consumer.product} certified Honeybee execution source revision ${accepted.sourceRevision}, ` +
        `not candidate ${candidate.sourceRevision}`,
    );
  }
  if (
    accepted.validationSurfaceVersion !== candidate.validationSurfaceVersion ||
    accepted.validationSurfaceDigest !== candidate.validationSurfaceDigest
  ) {
    throw new Error(
      `installed ${rollout.consumer.product} certificate does not match the candidate Honeybee validation surface`,
    );
  }
  const outsideCeiling = candidateFeatures.filter((feature) => !accepted.features.includes(feature));
  if (outsideCeiling.length > 0) {
    throw new Error(
      `Honeybee execution candidate advertises features outside the installed ${rollout.consumer.product} ` +
        `certificate: ${outsideCeiling.join(", ")}`,
    );
  }
  return accepted.mode;
}

export type ExecutionContractMaterialization = Pick<
  ExecutionContractCandidate,
  "schemaDigest" | "validationSurfaceVersion" | "validationSurfaceDigest" | "features"
>;

/** Prove copied/installed corpus bytes still equal the preflighted candidate. */
export function assertExecutionMaterializationMatches(
  expected: ExecutionContractMaterialization,
  actual: ExecutionContractMaterialization,
  label = "execution contract materialization",
): void {
  const sameFeatures =
    expected.features.length === actual.features.length &&
    expected.features.every((feature, index) => feature === actual.features[index]);
  if (
    expected.schemaDigest !== actual.schemaDigest ||
    expected.validationSurfaceVersion !== actual.validationSurfaceVersion ||
    expected.validationSurfaceDigest !== actual.validationSurfaceDigest ||
    !sameFeatures
  ) {
    throw new Error(`${label} does not equal the signed, preflighted candidate`);
  }
}

export type CodeSignResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CodeSignRunner = (args: readonly string[]) => CodeSignResult;

export type ApiarySignatureIdentity = {
  bundleIdentifier: string;
  teamIdentifier: string;
};

export type ApiarySignatureVerifier = (appBundlePath: string) => ApiarySignatureIdentity;

const systemCodeSign: CodeSignRunner = (args) => {
  const result = spawnSync("/usr/bin/codesign", [...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

function codeSignFailure(action: string, result: CodeSignResult): Error {
  const detail = result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return new Error(`cannot trust installed Apiary app: codesign ${action} failed (${detail})`);
}

/**
 * Verify the bundle's sealed resources against Apiary's designated
 * requirement, then independently read and return its identifier/team.
 */
export function verifyInstalledApiaryAppSignature(
  appBundlePath: string,
  runCodeSign: CodeSignRunner = systemCodeSign,
): ApiarySignatureIdentity {
  const verification = runCodeSign([
    "--verify",
    "--deep",
    "--strict",
    "--test-requirement",
    APIARY_DESIGNATED_REQUIREMENT,
    appBundlePath,
  ]);
  if (verification.error || verification.status !== 0) throw codeSignFailure("verification", verification);

  const details = runCodeSign(["--display", "--verbose=4", appBundlePath]);
  if (details.error || details.status !== 0) throw codeSignFailure("identity inspection", details);
  const output = `${details.stdout}\n${details.stderr}`;
  const bundleIdentifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() ?? "";
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() ?? "";
  if (bundleIdentifier !== APIARY_BUNDLE_IDENTIFIER || teamIdentifier !== APIARY_TEAM_IDENTIFIER) {
    throw new Error(
      `cannot trust installed Apiary app: expected ${APIARY_BUNDLE_IDENTIFIER}/${APIARY_TEAM_IDENTIFIER}, ` +
        `got ${bundleIdentifier || "(missing)"}/${teamIdentifier || "(missing)"}`,
    );
  }
  return { bundleIdentifier, teamIdentifier };
}

export type InstalledConsumerPreflightOptions = {
  /** Defaults to /Applications/Apiary.app. Any explicit path is required. */
  appBundlePath?: string;
  /** Injectable seam for unit tests; production uses macOS codesign. */
  verifyAppSignature?: ApiarySignatureVerifier;
};

export function preflightInstalledExecutionConsumer(
  candidate: ExecutionContractCandidate,
  options: InstalledConsumerPreflightOptions = {},
): ConsumerPreflightResult {
  const appBundlePath = options.appBundlePath ?? "/Applications/Apiary.app";
  const explicitBundleOverride = options.appBundlePath !== undefined;
  if (!existsSync(appBundlePath)) {
    if (!explicitBundleOverride) {
      return { kind: "standalone", detail: `Apiary is not installed at ${appBundlePath}` };
    }
    throw new Error(`explicit Apiary app bundle does not exist at ${appBundlePath}; refusing Honeybee deploy`);
  }

  // The certificate is trusted only after its containing app bundle and every
  // sealed resource pass the designated requirement.
  const signature = (options.verifyAppSignature ?? verifyInstalledApiaryAppSignature)(appBundlePath);
  if (
    signature.bundleIdentifier !== APIARY_BUNDLE_IDENTIFIER ||
    signature.teamIdentifier !== APIARY_TEAM_IDENTIFIER
  ) {
    throw new Error(
      `cannot trust installed Apiary app: expected ${APIARY_BUNDLE_IDENTIFIER}/${APIARY_TEAM_IDENTIFIER}, ` +
        `got ${signature.bundleIdentifier}/${signature.teamIdentifier}`,
    );
  }

  const manifestPath = join(appBundlePath, "Contents", "Resources", "execution-contract-consumer.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Apiary is installed but has no execution contract consumer certificate at ${manifestPath}; ` +
        `promote Apiary before deploying Honeybee`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `cannot read execution contract consumer certificate ${manifestPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const rollout = parseExecutionConsumerRollout(parsed);
  const mode = assertExecutionConsumerAccepts(rollout, candidate);
  return { kind: "accepted", manifestPath, product: rollout.consumer.product, mode };
}
