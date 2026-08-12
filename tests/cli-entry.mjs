// Full `npm test` transpiles once and routes integration-test CLI subprocesses
// to that test build. Focused `node --test` runs keep exercising source via
// tsx, so they never depend on a possibly stale generated tree.
if (process.env.HIVE_TEST_BUILT_CLI === "1") {
  await import(new URL("../.test-dist/src/cli.js", import.meta.url).href);
} else {
  // Focused source-mode tests invoke this plain-JS shim without a loader.
  // Register tsx for the lifetime of the CLI so commands that dynamically
  // import user-authored TypeScript keep the same behavior as `--import tsx`.
  await import("tsx");
  await import(new URL("../src/cli.ts", import.meta.url).href);
}
