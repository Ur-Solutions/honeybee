/**
 * WP3 manual smoke runner (SMOKE.md, steps 1–5 automated; step 6 stays manual).
 *
 *   npm run v2:smoke -- stub                 # wiring proof, no tokens
 *   npm run v2:smoke -- claude [--model m]   # real claude CLI from PATH
 *   npm run v2:smoke -- codex  [--model m]   # real codex app-server from PATH
 *   npm run v2:smoke -- grok   [--model m]   # real grok agent stdio from PATH
 *
 * Spawns ONE real bee (plus one short-lived boot-delivery bee), runs two short
 * turns, stops it, and prints a ✓/✗ checklist. Delivery uses daemon semantics:
 * a not_ready refusal is retried, never treated as failure — refusal is only a
 * failure where the contract says it must not happen. Everything lives in a
 * fresh temp dir; ~/.hive is never touched.
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HsrDriver, type SpawnSpec } from "./src/index.ts";
import { claudeAdapter, codexAdapter, grokAdapter, grokSpawnPlan, stubAdapter } from "../adapters/src/index.ts";
import type { DeliverOutcome, DriverObservation } from "../harness/src/driver.ts";

const here = dirname(fileURLToPath(import.meta.url));
const harness = process.argv[2];
const modelFlag = process.argv.indexOf("--model");
const model = modelFlag > 0 ? process.argv[modelFlag + 1] : undefined;

if (!harness || !["stub", "claude", "codex", "grok"].includes(harness)) {
  console.error("usage: npm run v2:smoke -- <stub|claude|codex|grok> [--model <m>]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "hive-smoke-"));
const logDir = join(dir, "logs");
const cwd = mkdtempSync(join(tmpdir(), "hive-smoke-cwd-"));

function specFor(): SpawnSpec {
  switch (harness) {
    case "claude":
      return {
        adapter: claudeAdapter,
        command: "claude",
        args: [
          "-p",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          ...(model ? ["--model", model] : []),
        ],
        cwd,
      };
    case "codex":
      return {
        adapter: codexAdapter({ cwd, ...(model ? { model } : {}) }),
        command: "codex",
        args: ["app-server"],
        cwd,
      };
    case "grok": {
      const home = join(dir, "grok-home");
      mkdirSync(home, { recursive: true });
      const realAuth = join(homedir(), ".grok", "auth.json");
      if (existsSync(realAuth)) copyFileSync(realAuth, join(home, "auth.json"));
      const planned = grokSpawnPlan([
        "--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio",
        ...(model ? ["--model", model] : []),
      ]);
      return {
        adapter: grokAdapter({ cwd }),
        command: "grok",
        args: planned.argv,
        cwd,
        env: { ...(process.env as Record<string, string>), GROK_HOME: home },
      };
    }
    default:
      return {
        adapter: stubAdapter,
        command: process.execPath,
        args: [join(here, "test-agent", "agent.mjs")],
        cwd,
        env: { STUB_BOOT_MS: "300", STUB_TURN_MS: "200" },
      };
  }
}

const spec = specFor();
const driver = new HsrDriver({ sessionLogDir: logDir, resolve: () => specFor() });
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const events: DriverObservation[] = [];
function drain(): void {
  events.push(...driver.observe());
}
async function waitFor(
  kind: DriverObservation["kind"],
  beeId: string,
  timeoutMs: number,
): Promise<DriverObservation | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    drain();
    const hit = events.find((e) => e.kind === kind && e.beeId === beeId);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Daemon semantics: not_ready means retry, not failure. */
async function deliverRetrying(
  beeId: string,
  messageId: number,
  body: string,
  timeoutMs: number,
): Promise<DeliverOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = driver.deliver(beeId, 1, messageId, body);
    if (out.accepted || out.reason !== "not_ready") return out;
    if (Date.now() > deadline) return out;
    await new Promise((r) => setTimeout(r, 500));
    drain();
  }
}

const BOOT_TIMEOUT = harness === "stub" ? 5_000 : 120_000;
const TURN_TIMEOUT = harness === "stub" ? 5_000 : 300_000;

try {
  // 1. spawn
  driver.start("smoke-1", 1);
  const live = driver.snapshotLive().find((p) => p.beeId === "smoke-1");
  check("pid + start-time captured at spawn", !!live, live ? `pid ${live.pid}` : "no live process");
  const booted = await waitFor("booted", "smoke-1", BOOT_TIMEOUT);
  check("booted observation", !!booted, spec.adapter.readyAtSpawn ? "synthetic (ready at spawn)" : "");

  if (!booted) {
    // Fail fast: everything downstream needs a live runtime — do not compound
    // timeouts for 20 minutes (lesson from the first claude smoke run).
    check("first turn", false, "skipped: no boot");
    check("follow-up turn", false, "skipped: no boot");
  } else {
    // 2–3. first turn
    const d1 = await deliverRetrying("smoke-1", 1, "Reply with exactly: SMOKE_TURN_1", TURN_TIMEOUT);
    check("first deliver accepted", d1.accepted, d1.reason ?? "");
    const t1s = await waitFor("turn_started", "smoke-1", TURN_TIMEOUT);
    const t1e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
    check("turn_started then turn_ended", !!t1s && !!t1e);

    // 3b. follow-up turn (retry covers harness-internal continuation turns)
    events.length = 0;
    const d2 = await deliverRetrying("smoke-1", 2, "Reply with exactly: SMOKE_TURN_2", TURN_TIMEOUT);
    check("follow-up deliver accepted", d2.accepted, d2.reason ?? "");
    const t2e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
    check("second turn completed", !!t2e);
  }

  // 4. delivery-at-boot contract — adapter-specific by design
  driver.start("smoke-2", 1);
  const early = driver.deliver("smoke-2", 1, 3, "Reply with exactly: SMOKE_EARLY");
  if (spec.adapter.readyAtSpawn) {
    check("deliver at spawn accepted (readyAtSpawn)", early.accepted, early.reason ?? "");
    const et = await waitFor("turn_ended", "smoke-2", TURN_TIMEOUT);
    check("spawn-time delivery produced a turn", !!et);
  } else {
    check("deliver while booting refused not_ready", !early.accepted && early.reason === "not_ready",
      early.accepted ? "was accepted" : early.reason ?? "");
    const boot2 = await waitFor("booted", "smoke-2", BOOT_TIMEOUT);
    const late = boot2
      ? await deliverRetrying("smoke-2", 4, "Reply with exactly: SMOKE_LATE", TURN_TIMEOUT)
      : ({ accepted: false, reason: "not_ready" } as DeliverOutcome);
    check("accepted after boot", late.accepted, boot2 ? (late.reason ?? "") : "no boot");
  }
  driver.stop("smoke-2", 1, "stopped_by_user");

  // 5. stop
  events.length = 0;
  const stopped = driver.stop("smoke-1", 1, "stopped_by_user");
  check("stop had a live process", stopped.hadProcess);
  const exited = await waitFor("exited", "smoke-1", 10_000);
  check("exited with stopped cause", exited?.exitCause === "stopped_by_user",
    `exitCause=${exited?.exitCause ?? "none"}`);

  // session log verbatim (file exists only if the runtime emitted any lines)
  const logPath = join(logDir, "smoke-1.jsonl");
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    const parseable = log.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    check("session log is verbatim native jsonl", log.length > 0 && parseable.length === log.length,
      `${log.length} lines`);
  } else {
    check("session log is verbatim native jsonl", false, "no log file — runtime emitted zero lines");
  }

  console.log(`\nsession logs: ${logDir}`);
  console.log("step 6 (auth-failure evidence) remains manual — see SMOKE.md.");
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0
    ? `\nSMOKE ${harness}: ALL ${results.length} CHECKS PASS`
    : `\nSMOKE ${harness}: ${failed.length}/${results.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  try { driver.stop("smoke-1", 1, "stopped_by_system"); } catch { /* already gone */ }
  try { driver.stop("smoke-2", 1, "stopped_by_system"); } catch { /* already gone */ }
}
