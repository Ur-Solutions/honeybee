/**
 * Per-harness TUI spawn shape for the tmux substrate (spec 05).
 *
 * HSR runs the headless protocol (claude stream-json, codex app-server, grok
 * ACP stdio) from the agent spec's `args`. Tmux runs the interactive TUI —
 * bee.args only (model/effort), plus the harness's observation locator or
 * hook installer so turn boundaries come from structured harness events.
 *
 * Delivery: grok ignores the tmux paste buffer (live 2026-08-17) → type mode;
 * claude/codex/agy paste. Observation homes honour GROK_HOME /
 * CLAUDE_CONFIG_DIR / CODEX_HOME / HOME so account isolation works the same
 * as HSR.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalCwd,
  claudeProjectKey,
  type ObservationSpec,
  type TmuxSpawnSpec,
} from "../../driver-tmux/src/index.ts";
import type { AgentSpecConfig } from "./config.ts";

export interface TmuxBee {
  agent: string;
  cwd: string;
  args: string[] | null;
  env: Record<string, string>;
}

const GROK_TMUX_DEFAULTS = ["--permission-mode", "bypassPermissions"];
const CLAUDE_TMUX_DEFAULTS = ["--dangerously-skip-permissions"];
const AGY_TMUX_DEFAULTS = ["--dangerously-skip-permissions"];

function envHome(env: Record<string, string>, key: string, fallback: string): string {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function tmuxDeliveryMode(agent: string): "paste" | "type" {
  return agent === "grok" ? "type" : "paste";
}

function agyWorkspaceNeedles(cwd: string): readonly string[] {
  const paths = [resolve(cwd), canonicalCwd(cwd)];
  const out: string[] = [];
  for (const path of paths) {
    for (const needle of [path, `file://${path}`]) {
      if (!out.includes(needle)) out.push(needle);
    }
  }
  return out;
}

export function tmuxObservationFor(bee: TmuxBee): ObservationSpec {
  const grace = 30_000;
  const quiesce = 1_500;
  switch (bee.agent) {
    case "agy": {
      const home = envHome(bee.env, "HOME", homedir());
      return {
        // The tmux driver injects agy lifecycle hooks by adding a per-bee,
        // driver-owned workspace via `--add-dir`. agy requires the hook config
        // at `<added-workspace>/.agents/hooks.json`; that workspace contains no
        // source tree, tokens, or helper scripts. Before launch the driver
        // also pre-seeds agy's trustedWorkspaces for both the bee cwd and that
        // hook workspace because `--dangerously-skip-permissions` does not
        // bypass agy's workspace trust dialog. The driver waits for agy's
        // `? for shortcuts` input prompt before reporting booted/idle, so
        // first-turn mail cannot be pasted into a boot modal or cold input
        // loop. SQLite is a render-only mirror.
        hooks: { kind: "agy" },
        bootReady: { kind: "agy-tui" },
        explicitTurnEnd: true,
        transcriptMirror: {
          locator: {
            dir: join(home, ".gemini", "antigravity-cli", "conversations"),
            match: /\.db$/,
            depth: 1,
            format: "agy-sqlite",
            containsAny: agyWorkspaceNeedles(bee.cwd),
          },
        },
        quiesceMs: quiesce,
        deliveryGraceMs: grace,
      };
    }
    case "grok": {
      const home = envHome(bee.env, "GROK_HOME", join(homedir(), ".grok"));
      return {
        transcript: {
          locator: {
            dir: join(home, "sessions", encodeURIComponent(canonicalCwd(bee.cwd))),
            match: /chat_history\.jsonl$/,
            depth: 2,
          },
          parser: "grok",
        },
        quiesceMs: quiesce,
        deliveryGraceMs: grace,
      };
    }
    case "claude": {
      const home = envHome(bee.env, "CLAUDE_CONFIG_DIR", join(homedir(), ".claude"));
      return {
        transcript: {
          locator: { dir: join(home, "projects", claudeProjectKey(bee.cwd)), match: /\.jsonl$/, depth: 2 },
          parser: "claude",
        },
        quiesceMs: quiesce,
        deliveryGraceMs: grace,
      };
    }
    case "codex": {
      const home = envHome(bee.env, "CODEX_HOME", join(homedir(), ".codex"));
      return {
        transcript: {
          locator: { dir: join(home, "sessions"), match: /^rollout-.*\.jsonl$/, depth: 5 },
          parser: "codex",
        },
        quiesceMs: quiesce,
        deliveryGraceMs: grace,
      };
    }
    default:
      return { paneFallback: true, deliveryGraceMs: 5_000 };
  }
}

/** TUI argv: bee.args on top of a small unattended-permission default. Spec.args (HSR plumbing) stay off. */
export function tmuxArgsFor(agent: string, beeArgs: string[] | null): string[] {
  const extra = beeArgs ?? [];
  if (agent === "grok" && !extra.includes("--permission-mode") && !extra.includes("--yolo") && !extra.includes("--always-approve")) {
    return [...GROK_TMUX_DEFAULTS, ...extra];
  }
  if (agent === "claude" && !extra.includes("--dangerously-skip-permissions")) {
    return [...CLAUDE_TMUX_DEFAULTS, ...extra];
  }
  if (agent === "agy" && !extra.includes("--dangerously-skip-permissions")) {
    return [...AGY_TMUX_DEFAULTS, ...extra];
  }
  return extra;
}

export function tmuxSpawnSpec(spec: AgentSpecConfig, bee: TmuxBee): TmuxSpawnSpec {
  return {
    command: spec.command,
    args: tmuxArgsFor(bee.agent, bee.args),
    cwd: bee.cwd,
    env: bee.env,
    deliveryMode: tmuxDeliveryMode(bee.agent),
    observation: tmuxObservationFor(bee),
  };
}
