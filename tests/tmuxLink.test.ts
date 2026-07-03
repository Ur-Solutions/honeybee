import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { parseSessionWindowInventory, sessionWindowInventory } from "../src/tmuxLink.js";

test("parseSessionWindowInventory maps one session's windows and active window", () => {
  const inventory = parseSessionWindowInventory(["@1\t0", "@2\t1", ""].join("\n"));
  assert.deepEqual(inventory.windows, ["@1", "@2"]);
  assert.equal(inventory.active, "@2");
});

test("sessionWindowInventory lists only the requested tmux session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-tmuxlink-"));
  const argsFile = join(dir, "args.txt");
  const fakeTmux = join(dir, "tmux");
  const previousPath = process.env.PATH;
  const previousSocket = process.env.HIVE_TMUX_SOCKET;
  const previousArgsFile = process.env.TMUX_ARGS_FILE;
  await writeFile(
    fakeTmux,
    [
      "#!/bin/sh",
      ": > \"$TMUX_ARGS_FILE\"",
      "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$TMUX_ARGS_FILE\"; done",
      "printf '@7\\t0\\n@8\\t1\\n'",
    ].join("\n"),
  );
  await chmod(fakeTmux, 0o755);

  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  delete process.env.HIVE_TMUX_SOCKET;
  process.env.TMUX_ARGS_FILE = argsFile;
  try {
    const inventory = await sessionWindowInventory("bee-one");
    assert.deepEqual(inventory.windows, ["@7", "@8"]);
    assert.equal(inventory.active, "@8");
    assert.deepEqual((await readFile(argsFile, "utf8")).trimEnd().split("\n"), [
      "list-windows",
      "-t",
      "=bee-one",
      "-F",
      "#{window_id}\t#{window_active}",
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.HIVE_TMUX_SOCKET;
    else process.env.HIVE_TMUX_SOCKET = previousSocket;
    if (previousArgsFile === undefined) delete process.env.TMUX_ARGS_FILE;
    else process.env.TMUX_ARGS_FILE = previousArgsFile;
    await rm(dir, { recursive: true, force: true });
  }
});
