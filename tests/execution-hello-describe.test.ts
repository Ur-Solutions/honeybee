// protocol.hello negotiation (corpus parity + fail-before-mutation gate) and
// owner-scoped node.describe under the LocalAuthority host binding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startHsrControlServer } from "../src/daemon/hsrControl.js";
import { loadExecutionContract } from "../src/execution/contract.js";
import { loadNodeIdentity } from "../src/execution/nodeState.js";
import { verifyCanonicalSignature } from "../src/execution/signing.js";
import { connectRpcClient } from "../src/hsr/rpc.js";
import type { JsonObject } from "../src/execution/contract.js";
import { installTestAuthority, makeService, withTempStore, OWNER_SCOPE } from "./executionTestKit.js";

const contract = loadExecutionContract();

test("protocol.hello reproduces every golden negotiation fixture byte-for-byte", async () => {
  await withTempStore(async () => {
    const service = makeService();
    for (const negotiation of contract.negotiations) {
      const { response } = service.hello(negotiation.request);
      assert.deepEqual(response, negotiation.response, negotiation.path);
      assert.deepEqual(service.validator.validate("protocol-hello-response", response).errors, []);
    }
  });
});

test("protocol.hello: incompatible protocol range and malformed requests fail closed", async () => {
  await withTempStore(async () => {
    const service = makeService();
    const result = service.hello({
      client: { product: "apiary", version: "0.4.0", protocolRange: "1.0" },
      requiredFeatures: ["local-core-v1"],
      optionalFeatures: [],
    });
    assert.equal(result.compatibility, "incompatible");
    assert.deepEqual(result.selectedFeatures, []);
    assert.throws(() => service.hello({ client: {} }), /invalid protocol.hello request/);
  });
});

test("node.describe: signed, owner-scoped, honest about absent harnesses and the delivered command set", async () => {
  await withTempStore(async () => {
    const { binding } = await installTestAuthority();
    const service = makeService();
    const outcome = await service.describe({ protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE, bindingId: binding.binding.bindingId });
    assert.ok("result" in outcome, JSON.stringify(outcome));
    const descriptor = outcome.result;
    assert.deepEqual(service.validator.validate("node-descriptor", descriptor).errors, []);
    const identity = await loadNodeIdentity();
    assert.ok(verifyCanonicalSignature(identity.publicKey, descriptor as Record<string, never>), "descriptor signature verifies");
    const harnesses = descriptor.harnesses as Array<Record<string, unknown>>;
    const claude = harnesses.find((entry) => entry.driverId === "claude")!;
    const codex = harnesses.find((entry) => entry.driverId === "codex")!;
    assert.equal(claude.status, "ready");
    // H3: exactly the effect-keyed commands the control socket delivers;
    // checkpoint is honestly absent, delivery is at-most-once.
    assert.deepEqual(claude.commands, ["send", "answer", "interrupt"], "H3 advertises the delivered command set");
    assert.equal(claude.commandDelivery, "at-most-once");
    assert.equal(claude.checkpoint, false);
    assert.equal(codex.status, "absent");
    assert.ok(typeof codex.installHint === "string" && codex.installHint.length > 0, "absent harness carries an install hint");
    const materializers = descriptor.materializers as Array<Record<string, unknown>>;
    assert.deepEqual(materializers[0]!.placements, ["explicit"], "H1 only claims explicit placement");
  });
});

test("node.describe: foreign owner scope, foreign binding, and missing binding are BINDING_DENIED", async () => {
  await withTempStore(async () => {
    const service = makeService();
    const before = await service.describe({ protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE });
    assert.ok("error" in before && before.error.code === "BINDING_DENIED", "no binding installed");
    await installTestAuthority();
    const foreignScope = await service.describe({ protocolVersion: "0.1", ownerScopeId: "oscope-other" });
    assert.ok("error" in foreignScope && foreignScope.error.code === "BINDING_DENIED");
    const foreignBinding = await service.describe({ protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE, bindingId: "bind-9999" });
    assert.ok("error" in foreignBinding && foreignBinding.error.code === "BINDING_DENIED");
    for (const outcome of [before, foreignScope, foreignBinding]) {
      assert.ok("error" in outcome);
      assert.deepEqual(service.validator.validate("error", outcome.error).errors, []);
    }
  });
});

test("connection gate: hello is required, incompatible hello refuses mutations, legacy methods untouched", async () => {
  await withTempStore(async () => {
    await installTestAuthority();
    const service = makeService();
    const server = await startHsrControlServer({ executionService: () => service });
    try {
      const client = await connectRpcClient(server.path);
      try {
        // Legacy methods never negotiate.
        const capabilities = (await client.call("capabilities")) as Record<string, unknown>;
        assert.equal(capabilities.execution, 1);

        // Any protocol method before hello is refused.
        const early = (await client.call("node.describe", { protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE })) as JsonObject;
        assert.equal((early.error as JsonObject).code, "PROTOCOL_INCOMPATIBLE");
        const earlyStart = (await client.call("run.start", { requestId: "req-x" })) as JsonObject;
        assert.equal((earlyStart.error as JsonObject).code, "PROTOCOL_INCOMPATIBLE");
        assert.equal(earlyStart.requestId, "req-x");

        // Incompatible hello: reads allowed, the mutation refused.
        const incompatible = (await client.call("protocol.hello", {
          client: { product: "apiary", version: "0.4.0", protocolRange: "0.1" },
          requiredFeatures: ["local-core-v1", "comb-activation-v1"],
          optionalFeatures: [],
        })) as JsonObject;
        assert.equal(incompatible.compatibility, "incompatible");
        assert.deepEqual(incompatible.missingRequiredFeatures, ["comb-activation-v1"]);
        const refused = (await client.call("run.start", { requestId: "req-y" })) as JsonObject;
        assert.equal((refused.error as JsonObject).code, "PROTOCOL_INCOMPATIBLE");
        const readAllowed = (await client.call("node.describe", { protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE })) as JsonObject;
        assert.equal(readAllowed.ownerScopeId, OWNER_SCOPE, "reads stay available for honest discovery");

        // A ready hello on the same connection unlocks everything.
        const ready = (await client.call("protocol.hello", {
          client: { product: "apiary", version: "0.4.0", protocolRange: "0.1" },
          requiredFeatures: ["local-core-v1"],
          optionalFeatures: [],
        })) as JsonObject;
        assert.equal(ready.compatibility, "ready");
        assert.equal(ready.schemaDigest, service.schemaDigest);
      } finally {
        client.close();
      }

      // A NEW connection must hello again.
      const fresh = await connectRpcClient(server.path);
      try {
        const gated = (await fresh.call("node.describe", { protocolVersion: "0.1", ownerScopeId: OWNER_SCOPE })) as JsonObject;
        assert.equal((gated.error as JsonObject).code, "PROTOCOL_INCOMPATIBLE");
      } finally {
        fresh.close();
      }
    } finally {
      await server.close();
    }
  });
});
