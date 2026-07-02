import assert from "node:assert/strict";
import { test } from "node:test";
import { hsrControlSocketPath } from "../src/hsr/runDir.js";

// Regression: the per-bee control socket is an AF_UNIX path, capped at ~104
// bytes on macOS (~108 on Linux). It must NOT live under the (arbitrarily long)
// run dir. Even with a relocated HIVE_STORE_ROOT and a long bee name, the path
// must stay comfortably under the limit or bind() fails with EINVAL.
test("hsr control socket path stays under the AF_UNIX limit", () => {
  const prev = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT =
      "/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/honeybee-hsr-a-very-long-relocated-store-root-XXXXXX";
    const longBee = "swarm-migration-worker-with-an-unusually-long-name-000042";
    const path = hsrControlSocketPath(longBee);
    assert.ok(
      Buffer.byteLength(path, "utf8") < 100,
      `control socket path too long (${Buffer.byteLength(path, "utf8")} bytes): ${path}`,
    );
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
  }
});

// Distinct bees must not collide on the same socket (the hash keys on the run dir).
test("hsr control socket paths are distinct per bee", () => {
  assert.notEqual(hsrControlSocketPath("alpha"), hsrControlSocketPath("beta"));
});
