import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

test("delivered credential locator v2 binds canonical owned home, generation, and inode; erase succeeds and is idempotent", async () => {
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
      generation: string;
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
    assert.equal(parsed.version, 2);
    assert.match(parsed.generation, /^[a-f0-9]{64}$/);
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

test("active root credential absence after a home rename fails closed with the locator and secret preserved", async () => {
  await withTempStore(async (dir) => {
    const bee = "root-home-rename";
    const secret = "ROOT-SECRET-MUST-REMAIN-LOCATABLE";
    const { home, locator } = await deliverFixture(dir, bee, secret);
    const renamedHome = `${home}-renamed`;
    let raced = false;

    const result = await shredDeliveredCredentials(bee, {
      async beforeOperation(operation) {
        if (operation !== "target-lstat" || raced) return;
        raced = true;
        await rename(home, renamedHome);
        await mkdir(home, { mode: 0o700 });
      },
    });

    assert.deepEqual(result, { ok: false, status: "incomplete", code: "target-unverified", retryable: true });
    assert.equal(await readFile(join(renamedHome, "auth.json"), "utf8"), secret);
    assert.equal(await exists(join(home, "auth.json")), false);
    assert.equal(await exists(locator), true, "active locator survives ambiguous absence");
  });
});

test("active nested credential absence after a home rename also fails closed", async () => {
  await withTempStore(async (dir) => {
    const bee = "nested-home-rename";
    const home = join(dir, "nested-race-home");
    const renamedHome = `${home}-renamed`;
    const secret = "NESTED-SECRET-MUST-REMAIN-LOCATABLE";
    await deliverAndRecordCredentials(bee, home, fakeCredentials(secret, "credentials/auth.json"));
    let raced = false;

    const result = await shredDeliveredCredentials(bee, {
      async beforeOperation(operation) {
        if (operation !== "target-lstat" || raced) return;
        raced = true;
        await rename(home, renamedHome);
        await mkdir(join(home, "credentials"), { recursive: true, mode: 0o700 });
      },
    });

    assert.deepEqual(result, { ok: false, status: "incomplete", code: "target-unverified", retryable: true });
    assert.equal(await readFile(join(renamedHome, "credentials", "auth.json"), "utf8"), secret);
    assert.equal(await exists(deliveredCredsPath(dir, bee)), true);
  });
});

test("a home rename with a replacement target never erases the replacement inode", async () => {
  await withTempStore(async (dir) => {
    const bee = "replacement-home-inode";
    const original = "ORIGINAL-DELIVERED-SECRET";
    const replacement = "REPLACEMENT-MUST-SURVIVE";
    const { home, locator } = await deliverFixture(dir, bee, original);
    const renamedHome = `${home}-renamed`;
    let raced = false;

    const result = await shredDeliveredCredentials(bee, {
      async beforeOperation(operation) {
        if (operation !== "target-lstat" || raced) return;
        raced = true;
        await rename(home, renamedHome);
        await mkdir(home, { mode: 0o700 });
        await writeFile(join(home, "auth.json"), replacement, { mode: 0o600 });
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "target-unverified");
    assert.equal(await readFile(join(renamedHome, "auth.json"), "utf8"), original);
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), replacement);
    assert.equal(await exists(locator), true);
  });
});

test("a durable zero receipt survives failure before unlink and makes restart retry idempotent", async () => {
  await withTempStore(async (dir) => {
    const bee = "zero-receipt-restart";
    const { target, locator } = await deliverFixture(dir, bee, "ZERO-BEFORE-RECEIPT-RESTART");

    const first = await shredDeliveredCredentials(bee, failOnceAt("target-unlink"));
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.code, "unlink-failed");
    assert.ok((await readFile(target)).every((byte) => byte === 0));
    assert.equal(await exists(locator), true);
    const receiptFiles = await readdir(join(dir, "hsr", bee, "delivered-creds-erasure"));
    assert.equal(receiptFiles.filter((name) => name.endsWith(".zeroed.json")).length, 1);

    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "erased", erasedFiles: 1 });
    assert.equal(await exists(target), false);
    assert.equal(await exists(locator), false);
    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "already-absent", erasedFiles: 0 });
  });
});

test("a receipt never authorizes unlinking a replacement inode", async () => {
  await withTempStore(async (dir) => {
    const bee = "receipt-replacement-inode";
    const replacement = "POST-RECEIPT-REPLACEMENT-MUST-SURVIVE";
    const { target, locator } = await deliverFixture(dir, bee, "ORIGINAL-SECRET");
    const first = await shredDeliveredCredentials(bee, failOnceAt("target-unlink"));
    assert.equal(first.ok, false);
    await unlink(target);
    await writeFile(target, replacement, { mode: 0o600 });

    const retry = await shredDeliveredCredentials(bee);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.code, "target-unverified");
    assert.equal(await readFile(target, "utf8"), replacement);
    assert.equal(await exists(locator), true);
  });
});

test("same-process concurrent erase calls join one complete per-bee transaction", async () => {
  await withTempStore(async (dir) => {
    const bee = "single-flight-erase";
    await deliverFixture(dir, bee, "SINGLE-FLIGHT-SECRET");
    let releaseWrite!: () => void;
    let reachedWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeReached = new Promise<void>((resolve) => { reachedWrite = resolve; });
    let writes = 0;
    const first = shredDeliveredCredentials(bee, {
      async beforeOperation(operation) {
        if (operation !== "target-write") return;
        writes += 1;
        reachedWrite();
        await writeReleased;
      },
    });
    await writeReached;
    const second = shredDeliveredCredentials(bee, {
      beforeOperation() {
        throw new Error("joined caller must not run a competing transaction");
      },
    });
    assert.equal(second, first, "concurrent callers receive the same transaction promise");
    releaseWrite();

    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, { ok: true, status: "erased", erasedFiles: 1 });
    assert.deepEqual(right, left);
    assert.equal(writes, 1);
  });
});

test("partial multi-file erase resumes from receipts without treating an active missing file as erased", async () => {
  await withTempStore(async (dir) => {
    const bee = "partial-multi-file";
    const home = join(dir, "partial-multi-home");
    const firstTarget = join(home, "first.json");
    const secondTarget = join(home, "nested", "second.json");
    await deliverAndRecordCredentials(bee, home, {
      files: [
        { homeRelPath: "first.json", contentB64: Buffer.from("FIRST-SECRET").toString("base64"), mode: 0o600 },
        { homeRelPath: "nested/second.json", contentB64: Buffer.from("SECOND-SECRET").toString("base64"), mode: 0o600 },
      ],
    });

    const first = await shredDeliveredCredentials(bee, failOnceAt("target-write", 2));
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.code, "overwrite-failed");
    assert.equal(await exists(firstTarget), false, "first file was receipt-backed and unlinked");
    assert.equal(await readFile(secondTarget, "utf8"), "SECOND-SECRET");
    assert.equal(await exists(deliveredCredsPath(dir, bee)), true);

    assert.deepEqual(await shredDeliveredCredentials(bee), { ok: true, status: "erased", erasedFiles: 1 });
    assert.equal(await exists(secondTarget), false);
    assert.equal(await exists(deliveredCredsPath(dir, bee)), false);
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
