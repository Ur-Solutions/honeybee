// Regenerates the deterministic execution-contract digest and every fixture
// field derived from it. Run after any schema/profile/state change:
//   npm run execution:digest
// It rewrites:
//   - contracts/execution/v1/digest.json (schemaDigest);
//   - requestDigest on valid execution-request-envelope fixtures
//     (canonical digest of the envelope body);
//   - receipt.requestDigest on response fixtures whose effectKey matches a
//     golden request envelope;
//   - schemaDigest inside negotiation responses and golden hello responses.
// Invoked through tsx so it can share src/execution + src/comb code.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "../src/comb/canonical.ts";
import { computeSchemaDigest, loadExecutionContract } from "../src/execution/contract.ts";

const root = fileURLToPath(new URL("../contracts/execution/v1/", import.meta.url));

function loadDoc(relativePath) {
  const path = join(root, relativePath);
  return { path, doc: JSON.parse(readFileSync(path, "utf8")) };
}

function saveDoc(path, doc) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function fixtureValues(doc) {
  return doc.values ?? (doc.value !== undefined ? [doc.value] : []);
}

const contract = loadExecutionContract(root);

// 1. Canonical body digests on golden request envelopes.
const effectDigests = new Map();
for (const fixture of contract.fixtures) {
  if (!fixture.valid || fixture.schema !== "execution-request-envelope") continue;
  const { path, doc } = loadDoc(join("fixtures", fixture.path));
  for (const value of fixtureValues(doc)) {
    value.requestDigest = canonicalDigest(value.body);
    effectDigests.set(value.effectKey, value.requestDigest);
  }
  saveDoc(path, doc);
}

// 2. Receipts replay the digest recorded for their effect key.
for (const fixture of contract.fixtures) {
  if (!fixture.valid || fixture.schema !== "execution-response-envelope") continue;
  const { path, doc } = loadDoc(join("fixtures", fixture.path));
  let changed = false;
  for (const value of fixtureValues(doc)) {
    const digest = value.receipt && effectDigests.get(value.receipt.effectKey);
    if (digest && value.receipt.requestDigest !== digest) {
      value.receipt.requestDigest = digest;
      changed = true;
    }
  }
  if (changed) saveDoc(path, doc);
}

// 3. Corpus digest (fixtures are excluded from it, so order is irrelevant).
const schemaDigest = computeSchemaDigest(contract);
saveDoc(join(root, "digest.json"), { schemaDigest });

// 4. Golden hello/negotiation responses pin the current digest.
for (const negotiation of contract.negotiations) {
  const { path, doc } = loadDoc(join("fixtures", negotiation.path));
  doc.response.schemaDigest = schemaDigest;
  saveDoc(path, doc);
}
for (const fixture of contract.fixtures) {
  if (!fixture.valid || fixture.schema !== "protocol-hello-response") continue;
  const { path, doc } = loadDoc(join("fixtures", fixture.path));
  for (const value of fixtureValues(doc)) value.schemaDigest = schemaDigest;
  saveDoc(path, doc);
}

console.log(`execution contract schemaDigest: ${schemaDigest}`);
