// End-to-end tests for the node-local execution admin RPCs
// (executionAdmin.bindLocalAuthorityHost / executionAdmin.registerWorkingCopy)
// over the real aggregate HSR control socket: TOFU first-bind, replay,
// conflicting takeover, tampered requests, path-free registration, restart
// persistence, corrupt-state fail-closed, socket permissions, and the
// canonical Apiary nodeId flowing through describe/lease/run.start.
import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { canonicalDigest } from "../src/comb/canonical.js";
import type { JsonValue } from "../src/comb/types.js";
import { startHsrControlServer } from "../src/daemon/hsrControl.js";
import type { JsonObject } from "../src/execution/contract.js";
import { ADMIN_MAX_REQUEST_BYTES } from "../src/execution/adminMethods.js";
import { materializeExplicitPlacement } from "../src/execution/launcher.js";
import type { RunLauncher } from "../src/execution/service.js";
import { executionRoot, readExecutionBinding, requireExecutionBinding } from "../src/execution/nodeState.js";
import { generateExecutionKeyPair, publicKeyFingerprint, signCanonical, type ExecutionKeyPair } from "../src/execution/signing.js";
import { readWorkingCopy } from "../src/execution/workingCopies.js";
import { connectRpcClient, type RpcClient } from "../src/hsr/rpc.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  makeService,
  withTempStore,
  CANONICAL_NODE_ID,
  OWNER_SCOPE,
  SNAPSHOT_DIGEST,
} from "./executionTestKit.js";

const ISSUED_AT = "2026-08-05T10:00:00Z";
const REVISION = "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c";
const COPY_PATH = "/tmp/honeybee-admin-test/worktrees/wc-0001";

type BindOverrides = {
  requestId?: string;
  mutateBody?: (body: JsonObject) => void;
  mutateSigned?: (envelope: JsonObject) => void;
  /** Sign with a different key than the carried authorityPublicKey. */
  signWith?: string;
};

function bindRequest(pair: ExecutionKeyPair, overrides: BindOverrides = {}): JsonObject {
  const body: JsonObject = {
    ownerScopeId: OWNER_SCOPE,
    authorityId: "la-0001",
    authorityEpoch: 1,
    bindingId: "bind-0001",
    nodeId: CANONICAL_NODE_ID,
    authorityPublicKey: pair.publicKey,
    keyFingerprint: publicKeyFingerprint(pair.publicKey),
  };
  overrides.mutateBody?.(body);
  const envelope: JsonObject = {
    adminVersion: 1,
    requestId: overrides.requestId ?? "req-bind-0001",
    issuedAt: ISSUED_AT,
    requestDigest: canonicalDigest(body as JsonValue),
    body,
  };
  envelope.signature = signCanonical(overrides.signWith ?? pair.privateKey, envelope);
  overrides.mutateSigned?.(envelope);
  return envelope;
}

type RegisterOverrides = {
  requestId?: string;
  mutateBody?: (body: JsonObject) => void;
  mutateSigned?: (envelope: JsonObject) => void;
  signWith?: string;
};

function registerRequest(pair: ExecutionKeyPair, overrides: RegisterOverrides = {}): JsonObject {
  const body: JsonObject = {
    ownerScopeId: OWNER_SCOPE,
    authorityId: "la-0001",
    authorityEpoch: 1,
    bindingId: "bind-0001",
    workingCopy: {
      workingCopyId: "wc-0001",
      nodeId: CANONICAL_NODE_ID,
      providerId: "native-host",
      productId: "prod-honeycomb-app",
      origin: "https://git.example.com/acme/honeycomb-app.git",
      revision: REVISION,
      branch: "run/wc-0001",
    },
    snapshotDigest: SNAPSHOT_DIGEST,
    locator: { path: COPY_PATH },
  };
  overrides.mutateBody?.(body);
  const envelope: JsonObject = {
    adminVersion: 1,
    requestId: overrides.requestId ?? "req-reg-0001",
    issuedAt: ISSUED_AT,
    requestDigest: canonicalDigest(body as JsonValue),
    body,
  };
  envelope.signature = signCanonical(overrides.signWith ?? pair.privateKey, envelope);
  overrides.mutateSigned?.(envelope);
  return envelope;
}

function errorCode(response: unknown): string | undefined {
  return ((response as JsonObject | null)?.error as JsonObject | undefined)?.code as string | undefined;
}

/** No `path` key and no locator path VALUE anywhere in the wire payload. */
function assertPathFree(payload: unknown, label: string): void {
  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes(COPY_PATH), `${label} must not leak the locator path: ${raw}`);
  assert.ok(!raw.includes('"path"'), `${label} must not carry a path field: ${raw}`);
}

async function withAdminServer(
  fn: (client: RpcClient, serverPath: string) => Promise<void>,
  serviceOptions: Parameters<typeof makeService>[0] = {},
): Promise<void> {
  const service = makeServiceLazily(serviceOptions);
  const server = await startHsrControlServer({ executionService: service });
  const client = await connectRpcClient(server.path);
  try {
    await fn(client, server.path);
  } finally {
    client.close();
    await server.close();
  }
}

// The execution service must be constructed AFTER the admin bind so its
// binding cache never observes the pre-bind state mid-test; building it
// lazily mirrors the daemon (built on first protocol call).
function makeServiceLazily(serviceOptions: Parameters<typeof makeService>[0] = {}): () => ReturnType<typeof makeService> {
  let service: ReturnType<typeof makeService> | undefined;
  return () => (service ??= makeService(serviceOptions));
}

async function hello(client: RpcClient): Promise<void> {
  const response = (await client.call("protocol.hello", {
    client: { product: "apiary", version: "0.4.0", protocolRange: "0.1" },
    requiredFeatures: ["local-core-v1"],
    optionalFeatures: [],
  })) as JsonObject;
  assert.equal(response.compatibility, "ready");
}

test("admin bind: TOFU first-bind, identical replay, and the canonical nodeId in node.describe", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    await withAdminServer(async (client, serverPath) => {
      // The admin surface is separately capability-advertised.
      const capabilities = (await client.call("capabilities")) as Record<string, unknown>;
      assert.equal(capabilities.executionAdmin, 1);
      assert.equal(capabilities.execution, 1);

      // Registration before any binding fails closed.
      const early = await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority));
      assert.equal(errorCode(early), "BINDING_DENIED");

      // First bind on a truly absent binding: TOFU install.
      const created = (await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject;
      assert.equal(created.error, undefined, JSON.stringify(created));
      assert.equal(created.outcome, "created");
      assert.equal(created.adminVersion, 1);
      assert.equal(created.requestId, "req-bind-0001");
      assert.equal(created.ownerScopeId, OWNER_SCOPE);
      assert.equal(created.nodeId, CANONICAL_NODE_ID);
      const bindingRef = created.binding as JsonObject;
      assert.equal(bindingRef.kind, "local-authority-host");
      assert.equal(bindingRef.bindingId, "bind-0001");
      assert.equal(bindingRef.authorityId, "la-0001");
      assert.equal(bindingRef.authorityEpoch, 1);
      assert.equal(bindingRef.keyFingerprint, publicKeyFingerprint(authority.publicKey));

      // Byte-identical replay returns the ORIGINAL record.
      const replayed = (await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject;
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.installedAt, created.installedAt);

      // The persisted binding pins the canonical Apiary nodeId.
      const persisted = await requireExecutionBinding();
      assert.equal(persisted.nodeId, CANONICAL_NODE_ID);

      // node.describe (after hello) exposes the BOUND canonical nodeId, not
      // the Honeybee-minted internal id.
      await hello(client);
      const descriptor = (await client.call("node.describe", {
        protocolVersion: "0.1",
        ownerScopeId: OWNER_SCOPE,
      })) as JsonObject;
      assert.equal(descriptor.nodeId, CANONICAL_NODE_ID, JSON.stringify(descriptor.error ?? {}));

      // Same-user restrictive socket + state permissions.
      const socketMode = (await stat(serverPath)).mode & 0o777;
      const dirMode = (await stat(dirname(serverPath))).mode & 0o777;
      const bindingMode = (await stat(join(executionRoot(), "binding.json"))).mode & 0o777;
      assert.equal(socketMode, 0o700, "control socket must be owner-only");
      assert.equal(dirMode, 0o700, "control socket directory must be owner-only");
      assert.equal(bindingMode, 0o600, "binding record must be owner-only");
    });
  });
});

test("admin bind: conflicting takeover, tampered signatures, and malformed shapes fail closed", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    const attacker = generateExecutionKeyPair();
    await withAdminServer(async (client) => {
      const created = (await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject;
      assert.equal(created.outcome, "created");

      // A DIFFERENT authority key (valid self-signature) can never take over.
      const takeover = await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(attacker));
      assert.equal(errorCode(takeover), "IDEMPOTENCY_CONFLICT");

      // Same key, different facts: epoch bump / scope / node changes conflict.
      for (const mutate of [
        (body: JsonObject) => (body.authorityEpoch = 2),
        (body: JsonObject) => (body.ownerScopeId = "oscope-other"),
        (body: JsonObject) => (body.nodeId = "node-other-host"),
        (body: JsonObject) => (body.bindingId = "bind-0002"),
      ]) {
        const outcome = await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority, { mutateBody: mutate }));
        assert.equal(errorCode(outcome), "IDEMPOTENCY_CONFLICT");
      }

      // The original binding survived every refusal above.
      const persisted = await requireExecutionBinding();
      assert.equal(persisted.binding.keyFingerprint, publicKeyFingerprint(authority.publicKey));
      assert.equal(persisted.binding.authorityEpoch, 1);

      // Signature by a key other than the carried one: possession not proven.
      const wrongSigner = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { signWith: attacker.privateKey }),
      );
      assert.equal(errorCode(wrongSigner), "BINDING_DENIED");

      // Corrupted signature bytes.
      const badSig = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateSigned: (envelope) => (envelope.signature = "ed25519:AAAA") }),
      );
      assert.equal(errorCode(badSig), "BINDING_DENIED");

      // Fingerprint not derived from the carried key.
      const badFingerprint = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateBody: (body) => (body.keyFingerprint = publicKeyFingerprint(attacker.publicKey)) }),
      );
      assert.equal(errorCode(badFingerprint), "SCHEMA_UNSUPPORTED");

      // Non-Ed25519 key material.
      const badKey = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, {
          mutateBody: (body) => {
            body.authorityPublicKey = Buffer.from("junk-key").toString("base64");
            body.keyFingerprint = publicKeyFingerprint(body.authorityPublicKey as string);
          },
        }),
      );
      assert.equal(errorCode(badKey), "SCHEMA_UNSUPPORTED");

      // Tampering the SIGNED nodeId breaks the canonical digest: a bind whose
      // nodeId differs from the signed host fact is impossible by shape.
      const nodeTamper = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateSigned: (envelope) => ((envelope.body as JsonObject).nodeId = "node-hijacked") }),
      );
      assert.equal(errorCode(nodeTamper), "SCHEMA_UNSUPPORTED");
      // Re-digesting the tampered body then breaks the signature instead.
      const nodeTamperRedigest = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, {
          mutateSigned: (envelope) => {
            (envelope.body as JsonObject).nodeId = "node-hijacked";
            envelope.requestDigest = canonicalDigest(envelope.body as JsonValue);
          },
        }),
      );
      assert.equal(errorCode(nodeTamperRedigest), "BINDING_DENIED");

      // Version drift, unknown fields, digest drift.
      const drift = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateSigned: (envelope) => (envelope.adminVersion = 2) }),
      );
      assert.equal(errorCode(drift), "SCHEMA_UNSUPPORTED");
      const unknownTop = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateSigned: (envelope) => (envelope.extra = true) }),
      );
      assert.equal(errorCode(unknownTop), "SCHEMA_UNSUPPORTED");
      const unknownBody = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateBody: (body) => (body.handoff = true) }),
      );
      assert.equal(errorCode(unknownBody), "SCHEMA_UNSUPPORTED");
      const digestDrift = await client.call(
        "executionAdmin.bindLocalAuthorityHost",
        bindRequest(authority, { mutateSigned: (envelope) => (envelope.requestDigest = `sha256:${"0".repeat(64)}`) }),
      );
      assert.equal(errorCode(digestDrift), "SCHEMA_UNSUPPORTED");

      // Oversized request: refused by the admin size bound.
      const oversized = await client.call("executionAdmin.bindLocalAuthorityHost", {
        adminVersion: 1,
        requestId: "x".repeat(ADMIN_MAX_REQUEST_BYTES),
      });
      assert.equal(errorCode(oversized), "SCHEMA_UNSUPPORTED");

      // The binding STILL survived every malformed attempt.
      assert.equal((await requireExecutionBinding()).binding.authorityEpoch, 1);
    });
  });
});

test("admin register: idempotent path-free registration with strict binding/node/shape gates", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    const attacker = generateExecutionKeyPair();
    await withAdminServer(async (client) => {
      assert.equal(
        ((await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject).outcome,
        "created",
      );

      // First registration: created, and the response is PATH-FREE.
      const created = (await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority))) as JsonObject;
      assert.equal(created.error, undefined, JSON.stringify(created));
      assert.equal(created.outcome, "created");
      assert.deepEqual(created.workingCopy, {
        workingCopyId: "wc-0001",
        nodeId: CANONICAL_NODE_ID,
        providerId: "native-host",
        productId: "prod-honeycomb-app",
        origin: "https://git.example.com/acme/honeycomb-app.git",
        revision: REVISION,
        branch: "run/wc-0001",
      });
      assert.equal(created.snapshotDigest, SNAPSHOT_DIGEST);
      assertPathFree(created, "registration response");

      // The registry HOLDS the locator path node-privately.
      const record = await readWorkingCopy("wc-0001");
      assert.equal(record?.path, COPY_PATH);
      assert.equal(record?.snapshotDigest, SNAPSHOT_DIGEST);

      // Identical replay.
      const replayed = (await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority))) as JsonObject;
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.registeredAt, created.registeredAt);
      assertPathFree(replayed, "replay response");

      // Same id, different content: silent redirection is refused, path-free.
      const redirected = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { mutateBody: (body) => ((body.locator as JsonObject).path = "/tmp/honeybee-admin-test/elsewhere") }),
      );
      assert.equal(errorCode(redirected), "IDEMPOTENCY_CONFLICT");
      assert.ok(!JSON.stringify(redirected).includes("/tmp/"), "conflict must not echo any path");
      assert.equal((await readWorkingCopy("wc-0001"))?.path, COPY_PATH, "conflict must not mutate the registry");

      // Cross-snapshot reuse of the same id is a conflict too.
      const crossSnapshot = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, {
          mutateBody: (body) => (body.snapshotDigest = `sha256:${"2f".repeat(32)}`),
        }),
      );
      assert.equal(errorCode(crossSnapshot), "IDEMPOTENCY_CONFLICT");

      // Binding/node/provider/epoch gates.
      const wrongNode = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { mutateBody: (body) => ((body.workingCopy as JsonObject).nodeId = "node-elsewhere") }),
      );
      assert.equal(errorCode(wrongNode), "BINDING_DENIED");
      const wrongProvider = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { mutateBody: (body) => ((body.workingCopy as JsonObject).providerId = "cloud-provider") }),
      );
      assert.equal(errorCode(wrongProvider), "CAPABILITY_MISMATCH");
      const wrongEpoch = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { mutateBody: (body) => (body.authorityEpoch = 2) }),
      );
      assert.equal(errorCode(wrongEpoch), "BINDING_DENIED");
      const wrongBinding = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { mutateBody: (body) => (body.bindingId = "bind-9999") }),
      );
      assert.equal(errorCode(wrongBinding), "BINDING_DENIED");

      // Signed by a key that is not the pinned authority.
      const foreignSigner = await client.call(
        "executionAdmin.registerWorkingCopy",
        registerRequest(authority, { signWith: attacker.privateKey }),
      );
      assert.equal(errorCode(foreignSigner), "BINDING_DENIED");

      // Path and content shape gates (all path-free refusals).
      for (const mutate of [
        (body: JsonObject) => ((body.locator as JsonObject).path = "relative/path"),
        (body: JsonObject) => ((body.locator as JsonObject).path = "/tmp/../etc/shadow"),
        (body: JsonObject) => ((body.workingCopy as JsonObject).revision = "main"),
        (body: JsonObject) => (body.snapshotDigest = "sha1:abc"),
        (body: JsonObject) => ((body.locator as JsonObject).branch = "run/wc-0001"),
        (body: JsonObject) => ((body.workingCopy as JsonObject).path = "/tmp/x"),
        (body: JsonObject) => (body.repoOrigin = "https://git.example.com/legacy.git"),
      ]) {
        const refused = await client.call(
          "executionAdmin.registerWorkingCopy",
          registerRequest(authority, { mutateBody: mutate, mutateSigned: undefined }),
        );
        assert.equal(errorCode(refused), "SCHEMA_UNSUPPORTED");
      }
    });
  });
});

test("admin seam end-to-end: bind + register over RPC, then run.start places on the registered copy as the canonical node", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    // A launcher that resolves the REAL explicit placement (the admin-
    // registered copy) before reporting the durable session facts, proving
    // the registered snapshot facts satisfy the leased placement end-to-end.
    const inner = countingLauncher();
    const materialized: string[] = [];
    const launcher: RunLauncher = async (request) => {
      const binding = await requireExecutionBinding();
      const copy = await materializeExplicitPlacement(binding.nodeId, request);
      materialized.push(copy.workingCopyId);
      return inner.launcher(request);
    };
    await withAdminServer(
      async (client) => {
        await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority));
        await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority));
        await hello(client);

        const binding = await requireExecutionBinding();
        const envelope = buildRunStartEnvelope({ authority, binding, nodeId: binding.nodeId });
        const response = (await client.call("run.start", envelope)) as JsonObject;
        assert.equal(response.error, undefined, JSON.stringify(response));
        assert.equal((response.receipt as JsonObject).outcome, "created");
        assert.deepEqual(materialized, ["wc-0001"], "run claimed the admin-registered working copy");
        assert.equal((await readWorkingCopy("wc-0001"))?.occupancy?.claimedByRunId, "run-0001");

        const projection = (await client.call("run.get", { protocolVersion: "0.1", runId: "run-0001" })) as JsonObject;
        const environment = projection.environment as JsonObject | undefined;
        assert.equal(environment?.nodeId, CANONICAL_NODE_ID, "run environment speaks the bound canonical nodeId");
        assertPathFree(projection, "run projection");
      },
      { launcher },
    );
  });
});

test("admin restart persistence: binding and registration replay identically on a fresh server", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    let installedAt = "";
    let registeredAt = "";
    await withAdminServer(async (client) => {
      const bind = (await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject;
      installedAt = String(bind.installedAt);
      const reg = (await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority))) as JsonObject;
      registeredAt = String(reg.registeredAt);
    });
    // Fresh server + fresh service over the same durable store.
    await withAdminServer(async (client) => {
      const bind = (await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority))) as JsonObject;
      assert.equal(bind.outcome, "replayed");
      assert.equal(bind.installedAt, installedAt);
      const reg = (await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority))) as JsonObject;
      assert.equal(reg.outcome, "replayed");
      assert.equal(reg.registeredAt, registeredAt);
      await hello(client);
      const descriptor = (await client.call("node.describe", { protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE })) as JsonObject;
      assert.equal(descriptor.nodeId, CANONICAL_NODE_ID);
    });
  });
});

test("admin corrupt durable state fails closed and is never overwritten", async () => {
  await withTempStore(async () => {
    const authority = generateExecutionKeyPair();
    await withAdminServer(async (client) => {
      await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority));

      // Corrupt working-copy registry: registration refuses, file untouched.
      const registryPath = join(executionRoot(), "working-copies.json");
      await writeFile(registryPath, "{ corrupted", "utf8");
      const refused = await client.call("executionAdmin.registerWorkingCopy", registerRequest(authority));
      assert.equal(errorCode(refused), "AUTHORITY_UNAVAILABLE");

      // Corrupt binding record: bind (even an honest replay) refuses and the
      // corrupt bytes are preserved for recovery, never rewritten.
      const bindingPath = join(executionRoot(), "binding.json");
      await writeFile(bindingPath, "{ corrupted binding", "utf8");
      const bind = await client.call("executionAdmin.bindLocalAuthorityHost", bindRequest(authority));
      assert.equal(errorCode(bind), "BINDING_DENIED");
      assert.equal(await readExecutionBinding().catch(() => "still-corrupt"), "still-corrupt");
    });
  });
});
