// Title generation for bees. The canonical `name`/`id` stays mechanical
// (tmux target, selectors); `title` is the semantic display layer. Titles come
// from three writers with strict precedence — user > auto > provider — so a
// hand-set title is never stomped by automation, and an auto-generated one is
// never stomped by a provider's first-user-prompt fallback.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namingConfig, type ResolvedNamingConfig } from "./config.js";
import { storeRoot } from "./fsx.js";
import type { SessionRecord } from "./store.js";
import { firstUserText, lastAssistantText, latestTranscript } from "./transcripts.js";

export type TitleSource = "user" | "auto" | "provider";

const TITLE_RANKS: Record<TitleSource, number> = { user: 3, auto: 2, provider: 1 };

export function titleRank(source: TitleSource | undefined): number {
  return source ? TITLE_RANKS[source] : 0;
}

/**
 * May a writer of `incoming` rank replace the record's current title?
 * Records titled before titleSource existed count as provider-titled, which
 * matches the old behavior (provider refreshes kept flowing).
 */
export function canWriteTitle(record: Pick<SessionRecord, "title" | "titleSource">, incoming: TitleSource): boolean {
  const existing = record.titleSource ?? (record.title ? "provider" : undefined);
  return titleRank(incoming) >= titleRank(existing);
}

export type TitleContext = {
  brief?: string;
  firstUser?: string;
  lastAssistant?: string;
};

export type GatherTitleContextOptions = {
  /**
   * Require a completed first exchange (user + assistant text) in the
   * transcript. The daemon's auto-titler sets this so bees are named from what
   * they are actually doing, not from a brief they have not acted on yet.
   */
  requireExchange?: boolean;
};

const CONTEXT_FIELD_MAX_CHARS = 700;

export async function gatherTitleContext(
  record: SessionRecord,
  options: GatherTitleContextOptions = {},
): Promise<TitleContext | null> {
  const tx = await latestTranscript(record.agent, record.cwd, {
    sinceIso: record.lastPromptAt ?? record.createdAt,
    prompt: record.lastPrompt,
    transcriptPath: record.transcriptPath,
    sessionId: record.providerSessionId,
    homePath: record.homePath,
  }).catch(() => null);

  const firstUser = clampContext(tx ? firstUserText(tx.rows) : "");
  const lastAssistant = clampContext(tx ? lastAssistantText(tx.rows) : "");
  if (options.requireExchange && (!firstUser || !lastAssistant)) return null;

  const brief = clampContext(record.brief ?? "");
  if (!brief && !firstUser && !lastAssistant) return null;

  return {
    ...(brief ? { brief } : {}),
    ...(firstUser ? { firstUser } : {}),
    ...(lastAssistant ? { lastAssistant } : {}),
  };
}

function clampContext(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= CONTEXT_FIELD_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, CONTEXT_FIELD_MAX_CHARS)}…`;
}

export function buildTitlePrompt(context: TitleContext): string {
  const sections: string[] = [
    "You name terminal coding-agent sessions. Reply with ONLY the title: 3-8 words, plain text, no quotes, no trailing period. Describe the task being worked on, not the agent.",
  ];
  if (context.brief) sections.push(`Task brief:\n${context.brief}`);
  if (context.firstUser) sections.push(`First user message:\n${context.firstUser}`);
  if (context.lastAssistant) sections.push(`Latest assistant reply:\n${context.lastAssistant}`);
  return sections.join("\n\n");
}

const GENERATED_TITLE_MAX_CHARS = 72;

/**
 * Coerce raw generator output into a displayable title: first non-empty line,
 * stripped of label prefixes, quoting, and markdown dressing. Returns
 * undefined when nothing usable remains.
 */
export function normalizeGeneratedTitle(raw: string): string | undefined {
  const line = raw
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;

  let title = line
    .replace(/^title\s*[:\-–]\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^[*_`"'“]+/, "")
    .replace(/[*_`"'”]+$/, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  if (title.length > GENERATED_TITLE_MAX_CHARS) {
    title = `${title.slice(0, GENERATED_TITLE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return title;
}

export type TitleRunner = (prompt: string, config: ResolvedNamingConfig) => Promise<string>;

export type GenerateTitleOptions = {
  config?: ResolvedNamingConfig;
  runner?: TitleRunner;
};

export async function generateTitle(context: TitleContext, options: GenerateTitleOptions = {}): Promise<string> {
  const config = options.config ?? namingConfig();
  const runner = options.runner ?? runTitleGenerator;
  const raw = await runner(buildTitlePrompt(context), config);
  const title = normalizeGeneratedTitle(raw);
  if (!title) {
    throw new Error(`title generator produced no usable title (${config.command ? "custom command" : config.tool})`);
  }
  return title;
}

// Generation is one short completion; anything slower than this is wedged.
const GENERATOR_TIMEOUT_MS = 60_000;

export async function runTitleGenerator(prompt: string, config: ResolvedNamingConfig): Promise<string> {
  if (config.command) return runCustomGenerator(config.command, prompt);
  if (config.tool === "codex") return runCodexGenerator(prompt, config.model);
  return runClaudeGenerator(prompt, config.model);
}

/**
 * Generator subprocesses run in a dedicated cwd so the provider's per-project
 * transcript folders for real bee cwds are never polluted with title-gen
 * sessions (the transcript matcher scores by project folder).
 */
async function generatorCwd(): Promise<string> {
  const dir = join(storeRoot(), "naming");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function runClaudeGenerator(prompt: string, model?: string): Promise<string> {
  const cwd = await generatorCwd();
  const args = ["-p", prompt, ...(model ? ["--model", model] : [])];
  const { stdout } = await execFileAsync("claude", args, cwd);
  return stdout;
}

async function runCodexGenerator(prompt: string, model?: string): Promise<string> {
  const cwd = await generatorCwd();
  // codex exec interleaves progress logging on stdout; --output-last-message
  // is the stable channel for the final agent message.
  const outDir = await mkdtemp(join(tmpdir(), "hive-naming-"));
  const outFile = join(outDir, "last-message.txt");
  try {
    const args = ["exec", "--skip-git-repo-check", ...(model ? ["-m", model] : []), "--output-last-message", outFile, prompt];
    await execFileAsync("codex", args, cwd);
    return await readFile(outFile, "utf8");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

async function runCustomGenerator(command: string, prompt: string): Promise<string> {
  const cwd = await generatorCwd();
  const { stdout } = await execFileAsync("sh", ["-c", command], cwd, prompt);
  return stdout;
}

function execFileAsync(file: string, args: string[], cwd: string, stdin?: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, timeout: GENERATOR_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split("\n").pop();
          reject(new Error(`${file} failed: ${error.message}${detail ? ` (${detail})` : ""}`));
          return;
        }
        resolve({ stdout });
      },
    );
    if (stdin !== undefined && child.stdin) {
      // A command that exits without reading stdin must not crash us with EPIPE.
      child.stdin.on("error", () => undefined);
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
