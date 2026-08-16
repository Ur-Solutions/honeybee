import { createHash } from "node:crypto";

/**
 * local-core-v1's one built-in runtime credential policy. Apiary explicitly
 * leases the operator's local `gh` OAuth session to one Run; Honeybee resolves
 * the material at runner startup and exposes only GH_TOKEN to that execution
 * Cell. No other ambient or generic credential identifier is accepted.
 */
export const LOCAL_GITHUB_SESSION_LEASE_PREFIX = "local-gh-session-v1:";

export function localGithubSessionCredentialLeaseId(runId: string): string {
  const runDigest = createHash("sha256").update(runId, "utf8").digest("base64url");
  return `${LOCAL_GITHUB_SESSION_LEASE_PREFIX}${runDigest}`;
}

export function hasExactLocalGithubSessionCredentialLease(
  runId: string | undefined,
  leaseIds: readonly string[] | undefined,
): boolean {
  return typeof runId === "string" &&
    Array.isArray(leaseIds) &&
    leaseIds.length === 1 &&
    leaseIds[0] === localGithubSessionCredentialLeaseId(runId);
}
