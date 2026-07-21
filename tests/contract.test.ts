import assert from "node:assert/strict";
import { test } from "node:test";
import { contractPostscript, normalizeContract, parseContractFlag, withContractPostscript } from "../src/contract.js";

test("parseContractFlag: shorthand, pairs, defaults", () => {
  assert.deepEqual(parseContractFlag("seal"), { completion: "seal" });
  assert.deepEqual(parseContractFlag("exit"), { completion: "exit" });
  assert.deepEqual(parseContractFlag("completion=seal"), { completion: "seal" });
  // completion defaults to seal when other keys are present
  assert.deepEqual(parseContractFlag("taskId=FL.3k2/s3,attempt=2"), { completion: "seal", taskId: "FL.3k2/s3", attempt: 2 });
  assert.deepEqual(parseContractFlag("completion=seal,sealType=implementation,taskId=X"), {
    completion: "seal",
    sealType: "implementation",
    taskId: "X",
  });
});

test("parseContractFlag: rejects invalid input", () => {
  assert.throws(() => parseContractFlag("completion=prose"), /completion must be one of/);
  assert.throws(() => parseContractFlag("sealType=poem"), /sealType must be one of/);
  assert.throws(() => parseContractFlag("attempt=0"), /attempt must be a positive integer/);
  assert.throws(() => parseContractFlag("attempt=1.5"), /attempt must be a positive integer/);
  assert.throws(() => parseContractFlag("taskId="), /taskId must be non-empty/);
  assert.throws(() => parseContractFlag("bogus=1"), /unknown key: bogus/);
  assert.throws(() => parseContractFlag("taskId=a,taskId=b"), /repeats key/);
  assert.throws(() => parseContractFlag("just-words"), /key=value pairs/);
});

test("normalizeContract: drops invalid shapes, keeps valid fields", () => {
  assert.equal(normalizeContract(null), undefined);
  assert.equal(normalizeContract({ completion: "prose" }), undefined);
  assert.deepEqual(normalizeContract({ completion: "seal", sealType: "review", taskId: "T", attempt: 3, junk: true }), {
    completion: "seal",
    sealType: "review",
    taskId: "T",
    attempt: 3,
  });
  // invalid optional fields are dropped, not fatal
  assert.deepEqual(normalizeContract({ completion: "seal", sealType: "poem", attempt: -1 }), { completion: "seal" });
});

test("contractPostscript: deterministic, carries match keys verbatim; exit has none", () => {
  const contract = parseContractFlag("completion=seal,sealType=implementation,taskId=FL.1/s2,attempt=2");
  const postscript = contractPostscript(contract)!;
  assert.equal(postscript, contractPostscript(contract)); // same bytes every time
  assert.match(postscript, /hive seal "\$bee" --from/);
  assert.match(postscript, /"taskId": "FL\.1\/s2"/);
  assert.match(postscript, /"attempt": 2/);
  assert.match(postscript, /taskId "FL\.1\/s2" and attempt 2/);
  assert.match(postscript, /never as completion/);
  assert.equal(contractPostscript({ completion: "exit" }), undefined);
});

test("withContractPostscript: appends to a brief or stands alone", () => {
  const contract = parseContractFlag("seal");
  assert.equal(withContractPostscript("do the task", undefined), "do the task");
  const appended = withContractPostscript("do the task", contract)!;
  assert.ok(appended.startsWith("do the task\n\n--- COMPLETION CONTRACT (hive) ---"));
  const alone = withContractPostscript(undefined, contract)!;
  assert.ok(alone.startsWith("--- COMPLETION CONTRACT (hive) ---"));
  assert.equal(withContractPostscript("brief", { completion: "exit" }), "brief");
});

test("contractPostscript snippet actually executes in a shell and records the seal", async (t) => {
  const { mkdtemp, writeFile, readFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "hive-postscript-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Fake `hive` on PATH: `here --id` prints a bee id; `seal` records its argv.
  const fakeHive = join(dir, "hive");
  await writeFile(
    fakeHive,
    `#!/bin/bash\nif [ "$1" = "here" ]; then echo "BEE.test"; exit 0; fi\nif [ "$1" = "seal" ]; then printf '%s\\n' "$@" > "${dir}/seal-call"; cp "$4" "${dir}/artifact-copy"; exit 0; fi\nexit 1\n`,
  );
  await chmod(fakeHive, 0o755);

  const postscript = contractPostscript(
    parseContractFlag("completion=seal,sealType=implementation,taskId=FL.9/s1,attempt=1"),
  )!;
  // The executable part of the postscript: from the bee= line through the
  // hive seal invocation.
  const lines = postscript.split("\n");
  const start = lines.findIndex((line) => line.startsWith("bee="));
  const end = lines.findIndex((line) => line.startsWith("hive seal "));
  assert.ok(start > 0 && end > start, "postscript carries the executable snippet");
  const script = lines.slice(start, end + 1).join("\n");

  await run("bash", ["-euo", "pipefail", "-c", script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir },
  });

  const sealCall = await readFile(join(dir, "seal-call"), "utf8");
  assert.match(sealCall, /^seal\nBEE\.test\n--from\n/);
  const artifact = JSON.parse(await readFile(join(dir, "artifact-copy"), "utf8")) as Record<string, unknown>;
  assert.equal(artifact.taskId, "FL.9/s1");
  assert.equal(artifact.attempt, 1);
  assert.equal(artifact.type, "implementation");
  assert.equal(artifact.status, "done");
});
