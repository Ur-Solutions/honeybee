import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { adapterFor } from "../src/hsr/adapters/index.js";
import { loadAdapterFor, type RunnerAdapterLoader } from "../src/hsr/adapter-loader.js";

const execFileAsync = promisify(execFile);

test("loadAdapterFor matches the complete synchronous registry", async () => {
  for (const harness of ["stub", "claude", "codex", "opencode", "cursor", "grok", "kimi"] as const) {
    const loaded = await loadAdapterFor(harness);
    assert.equal(loaded, adapterFor(harness), harness);
    assert.equal(loaded?.harness, harness);
  }
});

test("loadAdapterFor invokes only the requested own-key loader", async () => {
  const adapter = adapterFor("stub");
  assert.ok(adapter);
  const calls: string[] = [];
  const loader = (name: string): RunnerAdapterLoader => async () => {
    calls.push(name);
    return adapter;
  };
  const loaders = {
    claude: loader("claude"),
    codex: loader("codex"),
  };

  assert.equal(await loadAdapterFor("codex", loaders), adapter);
  assert.deepEqual(calls, ["codex"]);
  for (const harness of ["unknown", "__proto__", "constructor", "toString"]) {
    assert.equal(await loadAdapterFor(harness, loaders), undefined, harness);
  }
  assert.deepEqual(calls, ["codex"]);
});

test("a fresh Codex child graph does not load sibling adapters or CLI dispatch", async () => {
  const loaderSource = `
    export async function load(url, context, nextLoad) {
      if (url.includes("/src/")) process.stderr.write("LOAD " + url + "\\n");
      return nextLoad(url, context);
    }
  `;
  const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`;
  const runnerEntryUrl = pathToFileURL(`${process.cwd()}/src/hsr/runner-entry.ts`).href;
  const adapterLoaderUrl = pathToFileURL(`${process.cwd()}/src/hsr/adapter-loader.ts`).href;
  const script = `
    await import(${JSON.stringify(runnerEntryUrl)});
    const { loadAdapterFor } = await import(${JSON.stringify(adapterLoaderUrl)});
    await loadAdapterFor("codex");
  `;
  const { stderr } = await execFileAsync(
    process.execPath,
    ["--experimental-loader", loaderUrl, "--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: "1" }, maxBuffer: 1_000_000 },
  );

  assert.match(stderr, /LOAD .*\/hsr\/runner-entry\.ts/);
  assert.match(stderr, /LOAD .*\/hsr\/adapters\/codex\.ts/);
  for (const sibling of ["claude", "cursor", "grok", "kimi", "opencode", "stub"]) {
    assert.doesNotMatch(stderr, new RegExp(`/hsr/adapters/${sibling}\\.ts`), sibling);
  }
  assert.doesNotMatch(stderr, /\/src\/cli\.ts/);
  assert.doesNotMatch(stderr, /\/src\/drivers\.ts/);
  assert.doesNotMatch(stderr, /\/hsr\/adapters\/index\.ts/);
});
