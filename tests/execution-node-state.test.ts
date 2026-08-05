// Fail-closed durable node state for the execution protocol (H1): node
// identity minting vs corruption, binding install/tamper detection, and the
// node-local working-copy registry (content idempotence, occupancy, corruption).
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionProtocolError } from "../src/execution/errors.js";
import {
  executionRoot,
  installLocalAuthorityHostBinding,
  loadNodeIdentity,
  readExecutionBinding,
  requireExecutionBinding,
} from "../src/execution/nodeState.js";
import { generateExecutionKeyPair, publicKeyFingerprint, signCanonical, verifyCanonicalSignature } from "../src/execution/signing.js";
import { claimWorkingCopy, registerWorkingCopy, releaseWorkingCopy } from "../src/execution/workingCopies.js";
import { installTestAuthority, withTempStore, OWNER_SCOPE, SNAPSHOT_DIGEST as DIGEST } from "./executionTestKit.js";

async function expectCode(promise: Promise<unknown>, code: string, label: string): Promise<ExecutionProtocolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExecutionProtocolError, `${label}: expected ExecutionProtocolError, got ${String(error)}`);
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

test("node identity: minted once when absent, stable across reads", async () => {
  await withTempStore(async () => {
    const first = await loadNodeIdentity();
    const second = await loadNodeIdentity();
    assert.equal(first.nodeId, second.nodeId);
    assert.equal(first.publicKey, second.publicKey);
    assert.match(first.nodeId, /^node-[A-Za-z0-9._:-]+$/);
  });
});

test("node identity: corrupt record fails closed and is never silently reminted", async () => {
  await withTempStore(async () => {
    const path = join(executionRoot(), "node-identity.json");
    await loadNodeIdentity();
    await writeFile(path, "{ definitely not json", "utf8");
    await expectCode(loadNodeIdentity(), "AUTHORITY_UNAVAILABLE", "corrupt identity");
    assert.equal(await readFile(path, "utf8"), "{ definitely not json", "corrupt identity file must not be overwritten");
  });
});

test("node identity: incoherent key pair fails closed", async () => {
  await withTempStore(async () => {
    const identity = await loadNodeIdentity();
    const other = generateExecutionKeyPair();
    const path = join(executionRoot(), "node-identity.json");
    await writeFile(path, JSON.stringify({ ...identity, publicKey: other.publicKey }), "utf8");
    await expectCode(loadNodeIdentity(), "AUTHORITY_UNAVAILABLE", "incoherent keys");
  });
});

test("binding: absent fails closed; install/read roundtrip verifies fingerprint", async () => {
  await withTempStore(async () => {
    await expectCode(requireExecutionBinding(), "BINDING_DENIED", "absent binding");
    const { authority, binding } = await installTestAuthority();
    assert.equal(binding.ownerScopeId, OWNER_SCOPE);
    assert.equal(binding.binding.keyFingerprint, publicKeyFingerprint(authority.publicKey));
    const read = await requireExecutionBinding();
    assert.deepEqual(read.binding, binding.binding);
  });
});

test("binding: swapping the authority key without its fingerprint fails closed", async () => {
  await withTempStore(async () => {
    await installTestAuthority();
    const path = join(executionRoot(), "binding.json");
    const record = JSON.parse(await readFile(path, "utf8")) as { authorityPublicKey: string };
    record.authorityPublicKey = generateExecutionKeyPair().publicKey;
    await writeFile(path, JSON.stringify(record), "utf8");
    await expectCode(requireExecutionBinding(), "BINDING_DENIED", "tampered key");
  });
});

test("binding: corrupt record and non-ed25519 install key fail closed", async () => {
  await withTempStore(async () => {
    await installTestAuthority();
    const path = join(executionRoot(), "binding.json");
    await writeFile(path, "not json at all", "utf8");
    await expectCode(requireExecutionBinding(), "BINDING_DENIED", "corrupt binding");
    await assert.rejects(
      installLocalAuthorityHostBinding({
        ownerScopeId: OWNER_SCOPE,
        bindingId: "bind-0002",
        authorityId: "la-0002",
        authorityEpoch: 1,
        authorityPublicKey: Buffer.from("junk").toString("base64"),
        nodeId: "node-apiary-junk",
      }),
      /Ed25519/,
    );
  });
});

test("binding read returns null only on true absence", async () => {
  await withTempStore(async () => {
    assert.equal(await readExecutionBinding(), null);
  });
});

test("signing: canonical signatures verify and reject tampering", () => {
  const pair = generateExecutionKeyPair();
  const sig = signCanonical(pair.privateKey, { a: "one", b: 2 });
  assert.ok(verifyCanonicalSignature(pair.publicKey, { a: "one", b: 2, signature: sig }));
  // Key-order independence (canonical form).
  assert.ok(verifyCanonicalSignature(pair.publicKey, { b: 2, a: "one", signature: sig }));
  assert.ok(!verifyCanonicalSignature(pair.publicKey, { a: "one", b: 3, signature: sig }));
  assert.ok(!verifyCanonicalSignature(generateExecutionKeyPair().publicKey, { a: "one", b: 2, signature: sig }));
});

test("working copies: registration is idempotent by content, conflicts on redirection", async () => {
  await withTempStore(async () => {
    const input = { workingCopyId: "wc-1", productId: "prod-a", path: "/tmp/wc-1", snapshotDigest: DIGEST };
    const first = await registerWorkingCopy(input);
    const again = await registerWorkingCopy({ ...input });
    assert.equal(again.registeredAt, first.registeredAt, "identical re-register is a no-op");
    await expectCode(
      registerWorkingCopy({ ...input, path: "/tmp/other" }),
      "IDEMPOTENCY_CONFLICT",
      "content redirection",
    );
    await assert.rejects(registerWorkingCopy({ workingCopyId: "wc-2", productId: "p", path: "relative/path", snapshotDigest: DIGEST }), /absolute/);
  });
});

test("working copies: occupied copy cannot be redirected or double-claimed", async () => {
  await withTempStore(async () => {
    await registerWorkingCopy({ workingCopyId: "wc-1", productId: "prod-a", path: "/tmp/wc-1", snapshotDigest: DIGEST });
    const claimed = await claimWorkingCopy("wc-1", "run-A");
    assert.equal(claimed.occupancy?.claimedByRunId, "run-A");
    // Idempotent for the claiming run.
    await claimWorkingCopy("wc-1", "run-A");
    await expectCode(claimWorkingCopy("wc-1", "run-B"), "MATERIALIZATION_FAILED", "occupied claim");
    const conflict = await expectCode(
      registerWorkingCopy({ workingCopyId: "wc-1", productId: "prod-a", path: "/tmp/elsewhere", snapshotDigest: DIGEST }),
      "IDEMPOTENCY_CONFLICT",
      "occupied redirection",
    );
    assert.match(conflict.message, /already registered/);
    // Release is idempotent and scoped to the claiming run.
    await releaseWorkingCopy("wc-1", "run-B");
    await expectCode(claimWorkingCopy("wc-1", "run-B"), "MATERIALIZATION_FAILED", "still occupied after foreign release");
    await releaseWorkingCopy("wc-1", "run-A");
    await releaseWorkingCopy("wc-1", "run-A");
    await claimWorkingCopy("wc-1", "run-B");
  });
});

test("working copies: unknown id and corrupt registry fail closed", async () => {
  await withTempStore(async () => {
    await expectCode(claimWorkingCopy("wc-missing", "run-A"), "MATERIALIZATION_FAILED", "unknown working copy");
    await registerWorkingCopy({ workingCopyId: "wc-1", productId: "prod-a", path: "/tmp/wc-1", snapshotDigest: DIGEST });
    const path = join(executionRoot(), "working-copies.json");
    await writeFile(path, "{ torn", "utf8");
    await expectCode(claimWorkingCopy("wc-1", "run-A"), "AUTHORITY_UNAVAILABLE", "corrupt registry claim");
    await expectCode(
      registerWorkingCopy({ workingCopyId: "wc-2", productId: "prod-a", path: "/tmp/wc-2", snapshotDigest: DIGEST }),
      "AUTHORITY_UNAVAILABLE",
      "corrupt registry register",
    );
    assert.equal(await readFile(path, "utf8"), "{ torn", "corrupt registry must not be overwritten");
  });
});
