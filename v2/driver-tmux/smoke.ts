/**
 * WP5 manual smoke runner — the tmux driver against REAL harness TUIs
 * (SMOKE.md "tmux smokes" section). Validates the two surfaces CI cannot:
 * per-harness transcript formats against live streams, and the events-file
 * hook/notify contract against real hook invocations.
 *
 *   npm run v2:smoke:tmux -- stub               # wiring proof, no tokens (all evidence paths)
 *   npm run v2:smoke:tmux -- claude [--model m] # transcript phase + hooks phase
 *   npm run v2:smoke:tmux -- codex  [--model m] # transcript phase + notify phase
 *   npm run v2:smoke:tmux -- grok               # transcript phase (fixture-derived parser!)
 *
 * One command per harness; each phase spawns ONE bee via the real TmuxDriver
 * on a PRIVATE per-run socket (the ambient tmux server is never touched),
 * walks a ✓/✗ checklist, and fails fast — a dead prerequisite skips its
 * dependents instead of compounding timeouts (the WP3 smoke lesson).
 *
 * Home isolation: claude runs with a temp CLAUDE_CONFIG_DIR and codex with a
 * temp CODEX_HOME in BOTH phases — the runner never reads or writes the real
 * ~/.claude / ~/.codex config (it only COPIES credential files in, and
 * shreds the copies at teardown). grok has no home-relocation env var, so it
 * runs against the real ~/.grok; the runner only TAILS the transcript grok
 * itself writes there (read-only observation, no config touched).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TmuxDriver, type TmuxSpawnSpec } from "./src/driver.ts";
import { exactPaneTarget, TmuxServer } from "./src/tmux.ts";
import { parseEventsFileLine } from "./src/events-file.ts";
import { canonicalCwd, claudeProjectKey, findTranscript, type TranscriptLocator } from "./src/transcripts.ts";
import { verifyProcessIdentity } from "../driver-hsr/src/psutil.ts";
import type { DriverObservation } from "../harness/src/driver.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "test-agent", "agent.mjs");

const harness = process.argv[2] ?? "";
const modelFlag = process.argv.indexOf("--model");
const model = modelFlag > 0 ? process.argv[modelFlag + 1] : undefined;

if (!["stub", "claude", "codex", "grok"].includes(harness)) {
  console.error("usage: npm run v2:smoke:tmux -- <stub|claude|codex|grok> [--model <m>]");
  process.exit(2);
}

const real = harness !== "stub";
const READY_TIMEOUT = real ? 90_000 : 15_000; // TUI drawn + stable in the pane
const TURN_TIMEOUT = real ? 240_000 : 20_000; // one short prompt, start to end
const EXIT_TIMEOUT = 15_000;
const PANE_STABLE_MS = real ? 2_000 : 300;

type PhaseKind = "transcript" | "hooks" | "notify";
const PHASES: Record<string, PhaseKind[]> = {
  stub: ["transcript", "hooks", "notify"],
  claude: ["transcript", "hooks"],
  codex: ["transcript", "notify"],
  grok: ["transcript"],
};

const runDir = mkdtempSync(join(tmpdir(), "hive-tmux-smoke-"));
const socketPath = join(runDir, "tmux.sock");
/** Read-only pane peeking + final server teardown (same private socket). */
const server = new TmuxServer({ socketPath, allowKillServer: true });

const results: Array<[string, boolean, string]> = [];
function check(phase: string, name: string, ok: boolean, detail = ""): void {
  results.push([`${phase}: ${name}`, ok, detail]);
  console.log(`${ok ? "✓" : "✗"} [${phase}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Isolated harness homes (hooks/notify contract prep + auth copy-in)
// ---------------------------------------------------------------------------

/** Credential copies to shred at teardown (never leave tokens in /tmp). */
const credCopies: string[] = [];

function prepClaudeHome(home: string, cwd: string, eventsPath: string | null): void {
  mkdirSync(home, { recursive: true });
  // Skip onboarding + the folder-trust dialog for the temp cwd — WITHOUT
  // touching the real ~/.claude.json (CLAUDE_CONFIG_DIR isolates all of it).
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        // claude looks projects up by the REALPATHED cwd (/var → /private/var,
        // seen live in the trust dialog 2026-08-17); seed both keys.
        projects: {
          [cwd]: { hasTrustDialogAccepted: true },
          [canonicalCwd(cwd)]: { hasTrustDialogAccepted: true },
        },
      },
      null,
      2,
    ),
  );
  if (eventsPath != null) {
    // The events-file contract (src/events-file.ts): hooks append the payload
    // claude hands them on stdin, verbatim, one JSON object per line. The
    // trailing printf guards payloads that arrive without a newline.
    const append = `cat >> '${eventsPath}' && printf '\\n' >> '${eventsPath}'`;
    const group = [{ hooks: [{ type: "command", command: append }] }];
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: group, Stop: group, Notification: group } }, null, 2),
    );
  }
  // Auth: macOS claude reads OAuth creds from the shared Keychain, so an
  // isolated config dir usually authenticates as-is; elsewhere creds live in
  // ~/.claude/.credentials.json — copy READ-ONLY into the isolated home.
  const creds = join(homedir(), ".claude", ".credentials.json");
  const dst = join(home, ".credentials.json");
  if (existsSync(creds)) {
    copyFileSync(creds, dst);
    credCopies.push(dst);
  } else if (process.platform === "darwin") {
    // macOS: claude stores OAuth creds in the Keychain, and an ISOLATED config
    // dir does NOT read them (verified live: pane shows "Not logged in").
    // Extract and place them in the isolated home; shredded at teardown.
    try {
      const secret = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      ).trim();
      if (secret) {
        writeFileSync(dst, secret, { mode: 0o600 });
        credCopies.push(dst);
      }
    } catch {
      // No Keychain item / access denied — the login fail-fast below reports it.
    }
  }
}

function prepCodexHome(home: string, cwd: string, eventsPath: string | null): void {
  mkdirSync(home, { recursive: true });
  let toml = `# hive v2 tmux smoke — isolated CODEX_HOME (real ~/.codex untouched)\n`;
  if (eventsPath != null) {
    // codex invokes the notify program with the JSON payload as its final
    // argument; the helper appends it to the driver's events file — the
    // events-file contract shape, exercised by a REAL codex invocation.
    const helper = join(home, "notify-append.mjs");
    writeFileSync(
      helper,
      `import { appendFileSync } from "node:fs";\n` +
        `const [, , path, payload] = process.argv;\n` +
        `if (path && payload) appendFileSync(path, payload.trim() + "\\n");\n`,
    );
    toml += `notify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(helper)}, ${JSON.stringify(eventsPath)}]\n`;
  }
  toml += `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`;
  writeFileSync(join(home, "config.toml"), toml);
  const auth = join(homedir(), ".codex", "auth.json");
  if (existsSync(auth)) {
    const dst = join(home, "auth.json");
    copyFileSync(auth, dst);
    credCopies.push(dst);
  }
}

function printAuthHelp(phase: string, home: string, sessionName: string): void {
  if (harness === "claude") {
    console.error(`
  [${phase}] claude may be unauthenticated in the isolated CLAUDE_CONFIG_DIR:
    ${home}
  - macOS: claude reads OAuth credentials from the Keychain (shared) — auth
    normally just works; a first Keychain-access prompt may need approval.
  - other: copy credentials READ-ONLY into the isolated home and re-run:
      cp ~/.claude/.credentials.json '${home}/'
  - watch the live TUI:  tmux -S ${socketPath} attach -t '${sessionName}'  (detach: C-b d)
  Never edit ~/.claude or its settings.json — the runner never touches them.`);
  } else if (harness === "codex") {
    console.error(`
  [${phase}] codex may be unauthenticated in the isolated CODEX_HOME:
    ${home}
  - the runner copies ~/.codex/auth.json in automatically when it exists
    (${existsSync(join(homedir(), ".codex", "auth.json")) ? "it was found and copied" : "it was NOT found"});
    if missing, run \`codex login\` normally once, then re-run this smoke.
  - watch the live TUI:  tmux -S ${socketPath} attach -t '${sessionName}'  (detach: C-b d)
  Never edit ~/.codex/config.toml — the runner writes only its own temp copy.`);
  }
}

// ---------------------------------------------------------------------------
// Per-phase spec
// ---------------------------------------------------------------------------

interface PhaseCtx {
  kind: PhaseKind;
  beeId: string;
  cwd: string;
  home: string;
  eventsDir: string;
  eventsPath: string;
  spec: TmuxSpawnSpec;
  /** For the transcript-bound check + path printing (transcript phases). */
  locator: TranscriptLocator | null;
}

function makePhase(kind: PhaseKind): PhaseCtx {
  const dir = join(runDir, kind);
  const cwd = join(dir, "cwd");
  const home = join(dir, "home");
  const eventsDir = join(dir, "events");
  mkdirSync(cwd, { recursive: true });
  const beeId = `smoke-${kind}`;
  const eventsPath = join(eventsDir, `${beeId}.events.jsonl`); // driver derivation for a safe beeId
  const wired = kind === "transcript" ? null : eventsPath;
  // notify carries ONLY end-of-turn evidence, so its delivery-confirmation
  // grace must cover a whole real turn (a shorter grace would both flag the
  // delivery unconfirmed AND fold the eventual turn_ended away).
  const graceMs = kind === "notify" ? (real ? 60_000 : 5_000) : real ? 30_000 : 5_000;
  const quiesceMs = real ? 1_500 : 300;

  switch (harness) {
    case "claude": {
      prepClaudeHome(home, cwd, wired);
      const locator: TranscriptLocator | null =
        kind === "transcript"
          ? { dir: join(home, "projects", claudeProjectKey(cwd)), match: /\.jsonl$/, depth: 2 }
          : null;
      return {
        kind, beeId, cwd, home, eventsDir, eventsPath, locator,
        spec: {
          command: "claude",
          args: model ? ["--model", model] : [],
          cwd,
          env: { CLAUDE_CONFIG_DIR: home },
          observation: locator
            ? { transcript: { locator, parser: "claude" }, quiesceMs, deliveryGraceMs: graceMs }
            : { deliveryGraceMs: graceMs }, // hooks phase: events file is the ONLY source
        },
      };
    }
    case "codex": {
      prepCodexHome(home, cwd, wired);
      const locator: TranscriptLocator | null =
        kind === "transcript"
          ? { dir: join(home, "sessions"), match: /^rollout-.*\.jsonl$/, depth: 5 }
          : null;
      return {
        kind, beeId, cwd, home, eventsDir, eventsPath, locator,
        spec: {
          command: "codex",
          args: model ? ["--model", model] : [],
          cwd,
          env: { CODEX_HOME: home },
          observation: locator
            ? { transcript: { locator, parser: "codex" }, quiesceMs, deliveryGraceMs: graceMs }
            : { deliveryGraceMs: graceMs }, // notify phase: events file is the ONLY source
        },
      };
    }
    case "grok": {
      // Real home (no relocation var); observation tails the transcript grok
      // itself writes under ~/.grok — read-only, keyed to the fresh temp cwd.
      const locator: TranscriptLocator = {
        // grok keys sessions off process.cwd() (symlink-free) — canonical, like claude.
        dir: join(homedir(), ".grok", "sessions", encodeURIComponent(canonicalCwd(cwd))),
        match: /chat_history\.jsonl$/,
        depth: 2,
      };
      return {
        kind, beeId, cwd, home, eventsDir, eventsPath, locator,
        spec: {
          command: "grok",
          args: [],
          cwd,
          env: {},
          // Live 2026-08-17: grok takes NOTHING from the tmux paste buffer;
          // paced literal keystrokes land (echo-verified by the driver).
          deliveryMode: "type",
          observation: { transcript: { locator, parser: "grok" }, quiesceMs, deliveryGraceMs: graceMs },
        },
      };
    }
    default: {
      const txDir = join(dir, "tx");
      const locator: TranscriptLocator | null =
        kind === "transcript" ? { dir: txDir, match: /chat_history\.jsonl$/, depth: 2 } : null;
      return {
        kind, beeId, cwd, home, eventsDir, eventsPath, locator,
        spec: {
          command: process.execPath,
          args: [STUB],
          cwd,
          env: {
            TMUX_STUB_STYLE: kind, // transcript | hooks | notify
            TMUX_STUB_TURN_MS: "150",
            ...(locator ? { TMUX_STUB_TRANSCRIPT_DIR: txDir } : {}),
          },
          observation: locator
            ? { transcript: { locator, parser: "grok" }, quiesceMs, deliveryGraceMs: graceMs }
            : { deliveryGraceMs: graceMs },
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Pane helpers (read-only, same private socket)
// ---------------------------------------------------------------------------

function paneContent(sessionName: string): string | null {
  const res = server.try(["capture-pane", "-p", "-t", exactPaneTarget(sessionName)]);
  return res.status === 0 ? res.stdout : null;
}

/** Wait until the pane shows content that has stopped changing (TUI ready). */
async function waitPaneReady(sessionName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let lastChange = Date.now();
  for (;;) {
    const content = paneContent(sessionName) ?? "";
    if (content !== last) {
      last = content;
      lastChange = Date.now();
    }
    if (last.trim().length > 0 && Date.now() - lastChange >= PANE_STABLE_MS) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

function printPaneTail(phase: string, sessionName: string): void {
  const content = paneContent(sessionName);
  if (content == null) {
    console.error(`  [${phase}] pane already gone — no capture available`);
    return;
  }
  const lines = content.replace(/\s+$/, "").split("\n").slice(-15);
  console.error(`  [${phase}] pane tail:\n${lines.map((l) => `  │ ${l}`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// One phase = one bee through the full checklist
// ---------------------------------------------------------------------------

async function runPhase(ctx: PhaseCtx): Promise<void> {
  const phase = ctx.kind;
  const sessionName = `hive-v2-${ctx.beeId}-g1`;
  const driver = new TmuxDriver({ socketPath, eventsDir: ctx.eventsDir, resolve: () => ctx.spec });
  const events: DriverObservation[] = [];
  const drain = (): void => {
    events.push(...driver.observe());
  };
  const waitFor = async (
    kind: DriverObservation["kind"],
    timeoutMs: number,
  ): Promise<DriverObservation | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      drain();
      const hit = events.find((e) => e.kind === kind && e.beeId === ctx.beeId);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(100);
    }
  };
  const boundaryLabel =
    phase === "transcript"
      ? "turn boundary from transcript observation"
      : `turn boundary from ${phase === "hooks" ? "hook" : "notify"} evidence ALONE (no transcript source)`;
  const skipRest = (why: string, ...names: string[]): void => {
    for (const name of names) check(phase, name, false, `skipped: ${why}`);
  };
  const LATER = [
    boundaryLabel,
    ...(phase === "transcript" ? ["transcript file bound"] : ["hook/notify events received + parsed (events-file contract)"]),
    "follow-up turn",
    "delivery confirmed (no unconfirmed note)",
    "stop clean",
  ];

  console.log(`\n── phase: ${phase} ──`);
  const spawnedAt = Date.now();
  try {
    driver.start(ctx.beeId, 1);
    const live = driver.snapshotLive().find((p) => p.beeId === ctx.beeId);
    const identityOk = live != null && verifyProcessIdentity(live.pid, live.pidStartedAt, 5_000);
    check(phase, "spawn + exact pid identity", identityOk, live ? `pid ${live.pid}` : "no live process");
    if (!identityOk) {
      skipRest("no verified runtime", "TUI ready in pane", "first deliver accepted", ...LATER);
      return;
    }
    const booted = await waitFor("booted", 5_000);
    check(phase, "booted observation", booted != null, "synthetic — tmux boots to the input box");
    if (real) console.log(`  watch live: tmux -S ${socketPath} attach -t '${sessionName}'`);

    const ready = await waitPaneReady(sessionName, READY_TIMEOUT);
    let paneNow = paneContent(sessionName) ?? "";
    if (/trust this folder|Quick safety check/i.test(paneNow)) {
      // Trust dialog despite the seeded keys (isolated home only — accepting
      // writes trust into the TEMP .claude.json, never the real one).
      console.log(`  [${phase}] folder-trust dialog detected — accepting (isolated home)`);
      server.try(["send-keys", "-t", exactPaneTarget(sessionName), "Enter"]);
      await sleep(2_000);
      await waitPaneReady(sessionName, 15_000);
      paneNow = paneContent(sessionName) ?? "";
    }
    const loggedOut = /Not logged in|Run \/login/i.test(paneNow);
    check(
      phase,
      "TUI ready in pane",
      ready && !loggedOut,
      !ready ? `no stable pane content within ${READY_TIMEOUT}ms` : loggedOut ? "harness is NOT LOGGED IN" : "",
    );
    if (!ready || loggedOut) {
      printPaneTail(phase, sessionName);
      printAuthHelp(phase, ctx.home, sessionName);
      skipRest(loggedOut ? "not logged in" : "TUI never became ready", "first deliver accepted", ...LATER);
      return;
    }
    // Let the TUI finish post-draw work before pasting — a paste during the
    // initial redraw gets swallowed silently (verified live).
    await sleep(real ? 2_000 : 100);

    // Drop the synthetic boot turn_ended (bootedToIdle) before counting turns.
    drain();
    events.length = 0;

    // First delivered prompt → the observer must produce the boundary pair.
    const d1 = driver.deliver(ctx.beeId, 1, 1, "Reply with exactly SMOKE_TMUX_1 and nothing else");
    check(phase, "first deliver accepted", d1.accepted, d1.reason ?? "");
    if (!d1.accepted) {
      skipRest("delivery refused", ...LATER);
      return;
    }
    let t1s = await waitFor("turn_started", real ? 12_000 : 2_000);
    if (t1s == null) {
      // The TUI may have eaten the paste during a redraw. One retry.
      console.log(`  [${phase}] no turn within grace — retrying the paste once`);
      driver.deliver(ctx.beeId, 1, 1, "Reply with exactly SMOKE_TMUX_1 and nothing else");
      t1s = await waitFor("turn_started", TURN_TIMEOUT);
    }
    const t1e = t1s != null ? await waitFor("turn_ended", TURN_TIMEOUT) : null;
    check(
      phase,
      boundaryLabel,
      t1s != null && t1e != null,
      t1s == null ? "no turn_started" : t1e == null ? "turn_started but no turn_ended" : "",
    );
    if (t1s == null || t1e == null) {
      printPaneTail(phase, sessionName);
      printAuthHelp(phase, ctx.home, sessionName);
      skipRest("first turn never completed", ...LATER.slice(1));
      return;
    }

    if (phase === "transcript") {
      const tx = ctx.locator == null ? null : findTranscript(ctx.locator, spawnedAt - 2_000);
      check(phase, "transcript file bound", tx != null, tx ?? `nothing under ${ctx.locator?.dir}`);
      if (tx != null) console.log(`  transcript: ${tx}`);
    } else {
      // The events-file contract, against a REAL hook/notify invocation: the
      // file must exist and its lines must parse into boundary evidence.
      let lines: string[] = [];
      if (existsSync(ctx.eventsPath)) {
        lines = readFileSync(ctx.eventsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
      }
      const parsed = lines.flatMap((l) => parseEventsFileLine(l));
      const kinds = new Set(parsed.map((e) => e.kind));
      const ok =
        phase === "hooks"
          ? kinds.has("turn_started") && kinds.has("turn_ended") // UserPromptSubmit + Stop
          : kinds.has("turn_ended"); // agent-turn-complete
      check(
        phase,
        "hook/notify events received + parsed (events-file contract)",
        ok,
        `${lines.length} line(s) → ${parsed.length} event(s) [${[...kinds].join(", ") || "none"}]`,
      );
    }

    // Follow-up turn (idle → deliver → a second boundary pair).
    events.length = 0;
    // Post-turn TUIs redraw; settle briefly, then daemon semantics: one
    // re-deliver if no turn starts within grace (echo-verify already retries
    // the injection itself; this covers observer-side misses).
    await sleep(real ? 1_500 : 100);
    const d2 = driver.deliver(ctx.beeId, 1, 2, "Reply with exactly SMOKE_TMUX_2 and nothing else");
    let t2s = d2.accepted ? await waitFor("turn_started", real ? 15_000 : 2_000) : null;
    if (d2.accepted && t2s == null) {
      console.log(`  [${phase}] follow-up: no turn within grace — retrying the paste once`);
      driver.deliver(ctx.beeId, 1, 2, "Reply with exactly SMOKE_TMUX_2 and nothing else");
      t2s = await waitFor("turn_started", TURN_TIMEOUT);
    }
    const t2e = t2s != null ? await waitFor("turn_ended", TURN_TIMEOUT) : null;
    check(
      phase,
      "follow-up turn",
      d2.accepted && t2s != null && t2e != null,
      !d2.accepted ? (d2.reason ?? "refused") : t2s == null ? "no turn_started" : t2e == null ? "no turn_ended" : "",
    );

    // Delivery confirmation: when observation works, no unconfirmed note.
    drain();
    const notes = driver.observeDeliveryNotes();
    check(
      phase,
      "delivery confirmed (no unconfirmed note)",
      notes.length === 0,
      notes.length > 0 ? (notes[0]?.detail ?? "") : "",
    );

    // Stop: exact-identity TERM, exited with the stopped cause.
    events.length = 0;
    const stopped = driver.stop(ctx.beeId, 1, "stopped_by_user");
    const exited = await waitFor("exited", EXIT_TIMEOUT);
    check(
      phase,
      "stop clean",
      stopped.hadProcess && exited?.exitCause === "stopped_by_user",
      `hadProcess=${stopped.hadProcess} exitCause=${exited?.exitCause ?? "none"}`,
    );
    console.log(`  events file: ${ctx.eventsPath}${existsSync(ctx.eventsPath) ? "" : " (none written)"}`);
  } finally {
    driver.disposeAll();
  }
}

// ---------------------------------------------------------------------------
// Run all phases, verdict, teardown
// ---------------------------------------------------------------------------

try {
  console.log(`tmux smoke: ${harness}${model ? ` (--model ${model})` : ""}`);
  console.log(`run dir: ${runDir}\nprivate socket: ${socketPath}`);
  for (const kind of PHASES[harness] ?? []) {
    const phaseT0 = Date.now();
    await runPhase(makePhase(kind));
    console.log(`  [${kind}] phase wall time: ${((Date.now() - phaseT0) / 1000).toFixed(1)}s`);
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nartifacts kept for inspection under: ${runDir}`);
  if (harness === "grok") {
    console.log("note: grok's parser was fixture-derived — a passing transcript phase here is");
    console.log("      the first live validation of that format. Record the result in SMOKE.md.");
  }
  console.log(
    failed.length === 0
      ? `\nTMUX SMOKE ${harness}: ALL ${results.length} CHECKS PASS`
      : `\nTMUX SMOKE ${harness}: ${failed.length}/${results.length} FAILED`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  // Shred credential copies FIRST — never leave tokens in /tmp.
  for (const p of credCopies) rmSync(p, { force: true });
  try {
    server.killServer(); // the pinned private server only — never the ambient one
  } catch {
    // Server already gone.
  }
}
