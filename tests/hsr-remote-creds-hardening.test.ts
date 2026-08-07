import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  deliverAndRecordCredentials,
  readDeliveredCredentials,
  shredDeliveredCredentials,
  type DeliveredCredentialEraseOperation,
  type DeliveredCredentials,
} from "../src/hsr/remoteCreds.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const previous = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(process.cwd(), ".tmp-remote-creds-hardening-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function deliveredCredsPath(dir: string, bee: string): string {
  return join(dir, "hsr", bee, "delivered-creds.json");
}

function fakeCredentials(secret: Buffer | string, homeRelPath = "auth.json"): DeliveredCredentials {
  const content = typeof secret === "string" ? Buffer.from(secret) : secret;
  return {
    files: [{ homeRelPath, contentB64: content.toString("base64"), mode: 0o600 }],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function deliverFixture(dir: string, bee: string, secret: Buffer | string = "credential-secret"): Promise<{
  home: string;
  target: string;
  locator: string;
}> {
  const home = join(dir, `${bee}-home`);
  const target = join(home, "auth.json");
  const locator = deliveredCredsPath(dir, bee);
  await deliverAndRecordCredentials(bee, home, fakeCredentials(secret));
  return { home, target, locator };
}

function failOnceAt(operation: DeliveredCredentialEraseOperation, occurrence = 1): {
  beforeOperation: (candidate: DeliveredCredentialEraseOperation) => void;
} {
  let seen = 0;
  return {
    beforeOperation(candidate) {
      if (candidate !== operation) return;
      seen += 1;
      if (seen === occurrence) throw new Error("injected credential erase failure");
    },
  };
}

test("delivered credential locator v1 binds canonical owned home and inode; erase succeeds and is idempotent", async () => {
  await withTempStore(async (dir) => {
    const bee = "locator-valid";
    const secret = "SECRET-valid-locator-never-recorded";
    const { home, target, locator } = await deliverFixture(dir, bee, secret);

    assert.deepEqual(await readDeliveredCredentials(bee), [target]);
    assert.equal(await readFile(target, "utf8"), secret);
    assert.equal((await lstat(target)).mode & 0o777, 0o600);

    const rawLocator = await readFile(locator, "utf8");
    const parsed = JSON.parse(rawLocator) as {
      version: number;
      bee: string;
      home: { canonicalPath: string; device: string; inode: string; uid: string };
      files: Array<{
        homeRelPath: string;
        parentDirectories: Array<{ homeRelPath: string; device: string; inode: string }>;
        device: string;
        inode: string;
        linkCount: string;
      }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.bee, bee);
    assert.equal(parsed.home.canonicalPath, await realpath(home));
    assert.deepEqual(parsed.files.map((file) => file.homeRelPath), ["auth.json"]);
    assert.equal(parsed.files[0]!.linkCount, "1");
    assert.ok(!rawLocator.includes(secret), "locator never contains credential bytes");
    assert.ok(!rawLocator.includes(target), "locator stores a safe relative target, not an absolute file path");

    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "erased", erasedFiles: 1 });
    assert.equal(await exists(target), false);
    assert.equal(await exists(locator), false);
    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "already-absent", erasedFiles: 0 });
  });
});

test("valid nested OpenCode/Kimi recipe paths are contained, recorded by parent identity, and erased", async () => {
  await withTempStore(async (dir) => {
    const bee = "valid-nested";
    const home = join(dir, "nested-home");
    const openCodePath = join(home, "xdg-data", "opencode", "auth.json");
    const kimiPath = join(home, "credentials", "kimi-code.json");
    await deliverAndRecordCredentials(bee, home, {
      files: [
        { homeRelPath: "xdg-data/opencode/auth.json", contentB64: Buffer.from("OPENCODE-SECRET").toString("base64"), mode: 0o600 },
        { homeRelPath: "credentials/kimi-code.json", contentB64: Buffer.from("KIMI-SECRET").toString("base64"), mode: 0o600 },
      ],
    });

    assert.deepEqual(await readDeliveredCredentials(bee), [openCodePath, kimiPath]);
    const locator = JSON.parse(await readFile(deliveredCredsPath(dir, bee), "utf8")) as {
      files: Array<{ homeRelPath: string; parentDirectories: Array<{ homeRelPath: string }> }>;
    };
    assert.deepEqual(locator.files[0]!.parentDirectories.map((parent) => parent.homeRelPath), ["xdg-data", "xdg-data/opencode"]);
    assert.deepEqual(locator.files[1]!.parentDirectories.map((parent) => parent.homeRelPath), ["credentials"]);

    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "erased", erasedFiles: 2 });
    assert.equal(await exists(openCodePath), false);
    assert.equal(await exists(kimiPath), false);
  });
});

test("legacy or corrupt absolute victim locator is rejected without touching the victim", async () => {
  await withTempStore(async (dir) => {
    const bee = "absolute-victim";
    const victim = join(dir, "victim.txt");
    const locator = deliveredCredsPath(dir, bee);
    await writeFile(victim, "VICTIM-MUST-SURVIVE", { mode: 0o600 });
    await mkdir(join(dir, "hsr", bee), { recursive: true, mode: 0o700 });
    await writeFile(locator, `${JSON.stringify({ paths: [victim] })}\n`, { mode: 0o600 });

    assert.deepEqual(await shredDeliveredCredentials(bee), {
      ok: false,
      status: "incomplete",
      code: "locator-invalid",
      retryable: true,
    });
    assert.equal(await readFile(victim, "utf8"), "VICTIM-MUST-SURVIVE");
    assert.equal(await exists(locator), true, "bad locator is preserved for diagnosis/retry");
    await assert.rejects(() => readDeliveredCredentials(bee), /locator is invalid/);
  });
});

test("a final credential symlink is never followed or unlinked and the locator is preserved", async () => {
  await withTempStore(async (dir) => {
    const bee = "final-symlink";
    const { target, locator } = await deliverFixture(dir, bee);
    const victim = join(dir, "symlink-victim.txt");
    await writeFile(victim, "VICTIM-SYMLINK-CONTENT", { mode: 0o600 });
    await unlink(target);
    await symlink(victim, target);

    const result = await shredDeliveredCredentials(bee);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "target-unverified");
    assert.equal(await readFile(victim, "utf8"), "VICTIM-SYMLINK-CONTENT");
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await exists(locator), true);
  });
});

test("write-time intermediate symlink escape is rejected and never traversed", async () => {
  await withTempStore(async (dir) => {
    const bee = "intermediate-symlink";
    const home = join(dir, "home");
    const outside = join(dir, "outside");
    const victim = join(outside, "auth.json");
    await mkdir(home, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(victim, "INTERMEDIATE-VICTIM", { mode: 0o600 });
    await symlink(outside, join(home, "pivot"));

    const secret = "SECRET-MUST-NOT-LEAK-IN-ERROR";
    await assert.rejects(
      () => deliverAndRecordCredentials(bee, home, fakeCredentials(secret, "pivot/auth.json")),
      (error: Error) => {
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /remote credential (?:target|parent directory)/);
        return true;
      },
    );
    assert.equal(await readFile(victim, "utf8"), "INTERMEDIATE-VICTIM");
    assert.equal(await exists(deliveredCredsPath(dir, bee)), false);
  });
});

test("erase-time intermediate symlink retarget is rejected before zero or unlink", async () => {
  await withTempStore(async (dir) => {
    const bee = "erase-intermediate-link";
    const home = join(dir, "home");
    const outside = join(dir, "outside");
    const nestedTarget = join(home, "pivot", "auth.json");
    const victim = join(outside, "auth.json");
    await deliverAndRecordCredentials(bee, home, fakeCredentials("ORIGINAL-CREDENTIAL", "pivot/auth.json"));
    await rename(join(home, "pivot"), join(home, "original-pivot"));
    await mkdir(outside, { mode: 0o700 });
    await writeFile(victim, "INTERMEDIATE-RETARGET-VICTIM", { mode: 0o600 });
    await symlink(outside, join(home, "pivot"));

    const result = await shredDeliveredCredentials(bee);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "target-unverified");
    assert.equal(await readFile(victim, "utf8"), "INTERMEDIATE-RETARGET-VICTIM");
    assert.equal((await lstat(join(home, "pivot"))).isSymbolicLink(), true);
    assert.equal(await exists(deliveredCredsPath(dir, bee)), true);
    assert.equal(await readFile(join(home, "original-pivot", "auth.json"), "utf8"), "ORIGINAL-CREDENTIAL");
    assert.equal(nestedTarget, join(home, "pivot", "auth.json"));
  });
});

test("delivery rejects a pre-existing final symlink and a symlink-selected home", async () => {
  await withTempStore(async (dir) => {
    const victim = join(dir, "write-victim.txt");
    const home = join(dir, "home");
    await mkdir(home, { mode: 0o700 });
    await writeFile(victim, "WRITE-VICTIM", { mode: 0o600 });
    await symlink(victim, join(home, "auth.json"));
    await assert.rejects(() => deliverAndRecordCredentials("write-final-link", home, fakeCredentials("SECRET")));
    assert.equal(await readFile(victim, "utf8"), "WRITE-VICTIM");

    const physicalHome = join(dir, "physical-home");
    const linkedHome = join(dir, "linked-home");
    await mkdir(physicalHome, { mode: 0o700 });
    await symlink(physicalHome, linkedHome);
    await assert.rejects(() => deliverAndRecordCredentials("write-linked-home", linkedHome, fakeCredentials("SECRET")));
    assert.equal(await exists(join(physicalHome, "auth.json")), false);
  });
});

test("changed inode/retarget and a new hard link are not overwritten or removed", async () => {
  await withTempStore(async (dir) => {
    const changedBee = "changed-inode";
    const changed = await deliverFixture(dir, changedBee);
    await unlink(changed.target);
    await writeFile(changed.target, "NEW-INODE-MUST-SURVIVE", { mode: 0o600 });
    const changedResult = await shredDeliveredCredentials(changedBee);
    assert.equal(changedResult.ok, false);
    if (!changedResult.ok) assert.equal(changedResult.code, "target-unverified");
    assert.equal(await readFile(changed.target, "utf8"), "NEW-INODE-MUST-SURVIVE");
    assert.equal(await exists(changed.locator), true);

    const linkedBee = "changed-link-count";
    const linked = await deliverFixture(dir, linkedBee, "LINKED-CREDENTIAL");
    const secondName = join(dir, "second-hard-link");
    await link(linked.target, secondName);
    const linkedResult = await shredDeliveredCredentials(linkedBee);
    assert.equal(linkedResult.ok, false);
    if (!linkedResult.ok) assert.equal(linkedResult.code, "target-unverified");
    assert.equal(await readFile(secondName, "utf8"), "LINKED-CREDENTIAL");
    assert.equal(await exists(linked.locator), true);
  });
});

test("malformed and unreadable locators are typed failures and remain on disk", async () => {
  await withTempStore(async (dir) => {
    const malformedBee = "malformed-locator";
    const malformed = deliveredCredsPath(dir, malformedBee);
    await mkdir(join(dir, "hsr", malformedBee), { recursive: true, mode: 0o700 });
    await writeFile(malformed, "{ definitely-not-json", { mode: 0o600 });
    const malformedResult = await shredDeliveredCredentials(malformedBee);
    assert.equal(malformedResult.ok, false);
    if (!malformedResult.ok) assert.equal(malformedResult.code, "locator-invalid");
    assert.equal(await exists(malformed), true);

    const unreadableBee = "unreadable-locator";
    const { locator } = await deliverFixture(dir, unreadableBee);
    const unreadableResult = await shredDeliveredCredentials(unreadableBee, failOnceAt("locator-open"));
    assert.equal(unreadableResult.ok, false);
    if (!unreadableResult.ok) assert.equal(unreadableResult.code, "locator-unreadable");
    assert.equal(await exists(locator), true);

    await chmod(locator, 0o000);
    const permissionResult = await shredDeliveredCredentials(unreadableBee);
    assert.equal(permissionResult.ok, false);
    if (!permissionResult.ok) assert.ok(["locator-unreadable", "locator-invalid"].includes(permissionResult.code));
    assert.equal(await exists(locator), true);
    await chmod(locator, 0o600);
  });
});

test("partial overwrite failure preserves locator and a restart retry completes safely", async () => {
  await withTempStore(async (dir) => {
    const bee = "partial-overwrite";
    const secret = Buffer.alloc(96 * 1024, 0x53);
    const { target, locator } = await deliverFixture(dir, bee, secret);

    const first = await shredDeliveredCredentials(bee, failOnceAt("target-write", 2));
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.code, "overwrite-failed");
    assert.equal(await exists(locator), true);
    const partial = await readFile(target);
    assert.ok(partial.subarray(0, 64 * 1024).every((byte) => byte === 0));
    assert.ok(partial.subarray(64 * 1024).some((byte) => byte !== 0));

    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "erased", erasedFiles: 1 });
    assert.equal(await exists(target), false);
    assert.equal(await exists(locator), false);
  });
});

test("unlink and post-unlink stat failures preserve locator; restart retries are idempotent", async () => {
  await withTempStore(async (dir) => {
    const unlinkBee = "partial-unlink";
    const unlinkFixture = await deliverFixture(dir, unlinkBee, "ZERO-ME-THEN-RETRY");
    const unlinkResult = await shredDeliveredCredentials(unlinkBee, failOnceAt("target-unlink"));
    assert.equal(unlinkResult.ok, false);
    if (!unlinkResult.ok) assert.equal(unlinkResult.code, "unlink-failed");
    assert.equal(await exists(unlinkFixture.locator), true);
    assert.ok((await readFile(unlinkFixture.target)).every((byte) => byte === 0));
    assert.equal((await shredDeliveredCredentials(unlinkBee)).ok, true);
    assert.equal(await exists(unlinkFixture.locator), false);

    const statBee = "partial-stat";
    const statFixture = await deliverFixture(dir, statBee, "UNLINK-THEN-STAT-FAIL");
    const statResult = await shredDeliveredCredentials(statBee, failOnceAt("target-absence"));
    assert.equal(statResult.ok, false);
    if (!statResult.ok) assert.equal(statResult.code, "absence-unverified");
    assert.equal(await exists(statFixture.target), false, "unlink happened before absence verification failed");
    assert.equal(await exists(statFixture.locator), true, "locator survives uncertain absence");
    assert.deepEqual(await shredDeliveredCredentials(statBee), { ok: true, status: "erased", erasedFiles: 0 });
    assert.equal(await exists(statFixture.locator), false);
  });
});
