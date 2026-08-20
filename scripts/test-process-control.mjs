const SIGNAL_EXIT_CODES = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

/**
 * Flags for `node --test` workers. Open unix sockets / fake HSR `done`
 * promises otherwise keep isolation=process workers alive forever
 * (`--test-timeout=0` is Node's default).
 */
export function nodeTestCliFlags(options = {}) {
  const concurrency = options.concurrency ?? "8";
  const reporter = options.reporter ?? "dot";
  const timeout = options.timeout ?? "60000";
  const extra = options.extra ?? [];
  const flags = [
    "--test",
    `--test-concurrency=${concurrency}`,
    `--test-reporter=${reporter}`,
  ];
  if (options.forceExit !== false && !extra.includes("--test-force-exit")) {
    flags.push("--test-force-exit");
  }
  if (!extra.some((arg) => typeof arg === "string" && arg.startsWith("--test-timeout"))) {
    flags.push(`--test-timeout=${timeout}`);
  }
  flags.push(...extra);
  return flags;
}

export function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES.get(signal) ?? 1;
}

function processGroupAlive(pid, sendSignal) {
  try {
    sendSignal(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid, timeoutMs, sendSignal, sleep) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid, sendSignal)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/**
 * Stop the complete Node test-runner tree, not merely its immediate parent.
 * `node --test` owns worker descendants; leaving those behind after Ctrl-C both
 * burns CPU and lets them write into pipes whose readers have already exited.
 */
export async function terminateTestProcessTree(child, signal, options = {}) {
  const platform = options.platform ?? process.platform;
  const sendSignal = options.sendSignal ?? process.kill;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const graceMs = options.graceMs ?? 500;
  const pid = child.pid;

  if (platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }

  const sendGroup = (nextSignal) => {
    try {
      sendSignal(-pid, nextSignal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  sendGroup(signal);
  if (await waitForProcessGroupExit(pid, graceMs, sendSignal, sleep)) return;

  if (signal !== "SIGTERM") {
    sendGroup("SIGTERM");
    if (await waitForProcessGroupExit(pid, graceMs, sendSignal, sleep)) return;
  }

  sendGroup("SIGKILL");
  await waitForProcessGroupExit(pid, graceMs, sendSignal, sleep);
}
