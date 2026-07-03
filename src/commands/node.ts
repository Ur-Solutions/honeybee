// `hive node` / `hive substrate` — manage substrate endpoints (local + ssh-tmux).
// Extracted from cli.ts (HIVE-15).
import { actionLine, bold, cyan, dim, formatTable, gray, green, isPretty, magenta, red, yellow } from "../format.js";
import { bootstrapRunnerHost } from "../hsr/bootstrap.js";
import { LOCAL_NODE_NAME, authPolicyOf, describeAuthPolicy, listNodes, loadNode, registerNode, unregisterNode, updateNode, type AuthPolicy, type NodeRecord } from "../node.js";
import { nodeHealth, type NodeHealth } from "../nodeHealth.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { listSessions } from "../store.js";
import { clearSubstrateCache, remoteHsrSubstrateForNode } from "../substrates/index.js";

export async function cmdNode(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return nodeList();
    case "status":
      return nodeStatus(parsed);
    case "register":
      return nodeRegister(parsed);
    case "bootstrap":
      return nodeBootstrap(parsed);
    case "inspect":
      return nodeInspect(parsed);
    case "update":
      return nodeUpdate(parsed);
    case "unregister":
      return nodeUnregister(parsed);
    case "checkouts":
      return nodeCheckouts(parsed);
    default:
      throw new Error(`Unknown node subcommand: ${sub}\nUsage: hive node <list|status|register|bootstrap|inspect|update|unregister|checkouts>`);
  }
}


/**
 * `hive node status [<node>]` (APIA-96): probe each node (or the named one) and
 * print a health row — reachable + probe latency, and for remote-hsr nodes the
 * runner-host version (live ping, else recorded), a drift flag vs the local
 * bundle, and the live bee count. A per-node timeout keeps one dead node from
 * hanging the command; unreachable nodes render as `offline` with a reason.
 *
 * TODO(apiary): the Apiary runner-submenu node visibility is a separate change
 * in the apiary repo (a parallel effort owns it) — not wired here.
 */
export async function nodeStatus(parsed: Parsed) {
  const name = parsed.args[1];
  let nodes: NodeRecord[];
  if (name) {
    const record = await loadNode(name);
    if (!record) throw new Error(`Unknown node: ${name}`);
    nodes = [record];
  } else {
    nodes = await listNodes();
  }

  // Probe all nodes concurrently — each is independently time-bounded, so a dead
  // node only slows its own row, never the whole command.
  const healths = await Promise.all(nodes.map((node) => nodeHealth(node)));

  if (!isPretty()) {
    for (const h of healths) {
      console.log(
        [
          h.name,
          h.kind,
          h.reachable ? "online" : "offline",
          h.latencyMs ?? "",
          h.runnerHostVersion ?? "",
          h.versionDrift ? "drift" : "",
          h.liveBees ?? "",
          h.reason ?? "",
        ].join("\t"),
      );
    }
    return;
  }

  console.log(formatTable(
    [
      { header: "NODE" },
      { header: "KIND" },
      { header: "HEALTH" },
      { header: "LATENCY", align: "right" },
      { header: "VERSION" },
      { header: "BEES", align: "right" },
      { header: "DETAIL" },
    ],
    healths.map((h) => [
      bold(h.name),
      nodeKindLabel(h.kind),
      h.reachable ? green("● online") : red("○ offline"),
      h.latencyMs === null ? dim("-") : dim(`${h.latencyMs}ms`),
      formatNodeVersion(h),
      h.liveBees === undefined ? dim("-") : String(h.liveBees),
      h.reason ? red(h.reason) : dim(""),
    ]),
  ));
}


/** Version cell: `<core>` for remote-hsr, plus a drift marker; `-` otherwise. */
export function formatNodeVersion(h: NodeHealth): string {
  if (h.kind !== "remote-hsr" || !h.runnerHostVersion) return dim("-");
  return h.versionDrift
    ? `${h.runnerHostVersion} ${yellow("(drift)")}`
    : dim(h.runnerHostVersion);
}


export function nodeKindLabel(kind: NodeRecord["kind"] | string, display: "short" | "full" = "short"): string {
  const label = display === "full"
    ? kind
    : kind === "local-tmux"
      ? "local"
      : kind === "ssh-tmux"
        ? "ssh"
        : kind === "remote-hsr"
          ? "hsr"
          : kind;
  switch (kind) {
    case "local-tmux":
      return gray(label);
    case "ssh-tmux":
      return cyan(label);
    case "remote-hsr":
      return magenta(label);
    default:
      return yellow(label || "unknown");
  }
}


/**
 * `hive node checkouts <node>` (APIA-95): list the working-copy checkouts
 * provisioned on a remote-hsr node (name/branch/repo/path). Groundwork for
 * Apiary's "where-it-lives" selector (substrates-research §5.3 / arch §7.5).
 */
export async function nodeCheckouts(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node checkouts <node>");
  const record = await loadNode(name);
  if (!record) throw new Error(`Unknown node: ${name}`);
  if (record.kind !== "remote-hsr") {
    throw new Error(`node ${name} is kind ${record.kind}; checkouts are only available on remote-hsr nodes`);
  }
  const substrate = remoteHsrSubstrateForNode(record);
  try {
    const rows = await substrate.listCheckouts();
    if (!isPretty()) {
      for (const r of rows) {
        console.log(`${r.name}\t${r.branch ?? ""}\t${r.repo ?? ""}\t${r.path}${r.dirty ? "\tdirty" : ""}`);
      }
      return;
    }
    if (rows.length === 0) {
      console.log(dim(`No checkouts on ${name}.`));
      return;
    }
    console.log(formatTable(
      [{ header: "NAME" }, { header: "BRANCH" }, { header: "REPO" }, { header: "PATH" }],
      rows.map((r) => [
        bold(r.name),
        r.branch ?? "",
        dim(r.repo ?? ""),
        dim(r.path) + (r.dirty ? ` ${red("dirty")}` : ""),
      ]),
    ));
  } finally {
    // A one-shot query: tear down the forwarded tunnel so the CLI exits cleanly.
    await substrate.close().catch(() => undefined);
  }
}


export async function nodeList() {
  const nodes = await listNodes();
  if (!isPretty()) {
    for (const n of nodes) console.log(`${n.kind}\t${n.name}\t${n.endpoint}\t${n.status ?? "unknown"}\t${n.capabilities.join(",") || "*"}`);
    return;
  }
  if (nodes.length === 0) {
    console.log(dim("No nodes registered. The implicit 'local' node is always available."));
    return;
  }
  console.log(formatTable(
    [
      { header: "KIND" },
      { header: "NAME" },
      { header: "ENDPOINT" },
      { header: "STATUS" },
      { header: "CAPABILITIES" },
      { header: "DESCRIPTION" },
    ],
    nodes.map((n) => [
      nodeKindLabel(n.kind),
      bold(n.name),
      dim(n.endpoint),
      formatNodeStatus(n.status),
      dim(n.capabilities.join(", ")),
      dim(n.description ?? ""),
    ]),
  ));
}


export function formatNodeStatus(status: NodeRecord["status"]): string {
  switch (status) {
    case "online":
      return green("● online");
    case "offline":
      return red("○ offline");
    case "unknown":
    default:
      return dim("? unknown");
  }
}


/**
 * ssh args almost always start with "-", which the flag parser reads as the
 * next flag (leaving --ssh-args === true). Silently dropping them would
 * register the node without its ssh config, so demand the = form instead.
 */
export function parseSshArgsFlag(parsed: Parsed): string[] | undefined {
  const raw = flag(parsed, "ssh-args");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error('--ssh-args requires a value; use --ssh-args="-F /path/to/config" (the = form is required for values starting with -)');
  }
  return raw.split(/\s+/).filter(Boolean);
}


export async function nodeRegister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node register <name> --kind <local-tmux|ssh-tmux|remote-hsr> --endpoint <addr> [--capabilities a,b,c] [--description \"...\"] [--ssh-command ssh] [--ssh-args=\"-F /path/to/config\"] [--auth-policy <local-only|ephemeral-token|api-key>]");
  const kindRaw = flag(parsed, "kind");
  if (typeof kindRaw !== "string") throw new Error("--kind is required (local-tmux, ssh-tmux, or remote-hsr)");
  const endpointRaw = flag(parsed, "endpoint");
  if (typeof endpointRaw !== "string") throw new Error("--endpoint is required");
  const capabilitiesRaw = flag(parsed, "capabilities");
  const capabilities = typeof capabilitiesRaw === "string"
    ? capabilitiesRaw.split(",").map((c) => c.trim()).filter(Boolean)
    : undefined;
  const description = typeof flag(parsed, "description") === "string" ? String(flag(parsed, "description")) : undefined;
  const sshCommand = typeof flag(parsed, "ssh-command") === "string" ? String(flag(parsed, "ssh-command")) : undefined;
  const sshArgs = parseSshArgsFlag(parsed);
  const authPolicy = typeof flag(parsed, "auth-policy") === "string" ? (String(flag(parsed, "auth-policy")) as AuthPolicy) : undefined;
  const record = await registerNode({
    name,
    kind: kindRaw as NodeRecord["kind"],
    endpoint: endpointRaw,
    ...(capabilities ? { capabilities } : {}),
    ...(description ? { description } : {}),
    ...(sshCommand ? { sshCommand } : {}),
    ...(sshArgs ? { sshArgs } : {}),
    ...(authPolicy ? { authPolicy } : {}),
  });
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(record.name), record.kind, dim(record.endpoint)]));
  else console.log(`registered\t${record.name}\t${record.kind}\t${record.endpoint}`);
}


export async function nodeBootstrap(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node bootstrap <name> --endpoint <user@host> [--capabilities a,b,c] [--description \"...\"] [--ssh-command ssh] [--ssh-args=\"-F /path/to/config\"] [--min-node <major>]");
  const endpointRaw = flag(parsed, "endpoint");
  if (typeof endpointRaw !== "string") throw new Error("--endpoint is required (e.g. --endpoint user@host)");
  const capabilitiesRaw = flag(parsed, "capabilities");
  const capabilities = typeof capabilitiesRaw === "string"
    ? capabilitiesRaw.split(",").map((c) => c.trim()).filter(Boolean)
    : undefined;
  const description = typeof flag(parsed, "description") === "string" ? String(flag(parsed, "description")) : undefined;
  const sshCommand = typeof flag(parsed, "ssh-command") === "string" ? String(flag(parsed, "ssh-command")) : undefined;
  const sshArgs = parseSshArgsFlag(parsed);
  const minNodeRaw = flag(parsed, "min-node");
  const minNodeMajor = typeof minNodeRaw === "string" && Number.isFinite(Number(minNodeRaw)) ? Number(minNodeRaw) : undefined;

  const result = await bootstrapRunnerHost({
    name,
    endpoint: endpointRaw,
    ...(capabilities ? { capabilities } : {}),
    ...(description ? { description } : {}),
    ...(sshCommand ? { sshCommand } : {}),
    ...(sshArgs ? { sshArgs } : {}),
    ...(minNodeMajor !== undefined ? { minNodeMajor } : {}),
  });
  clearSubstrateCache();
  if (isPretty()) {
    console.log(actionLine("ok", "node", [
      bold(result.node.name),
      "remote-hsr",
      dim(result.node.endpoint),
      dim(`runner-host ${result.version}`),
      dim(result.deployed ? "deployed" : "up-to-date"),
    ]));
  } else {
    console.log(`bootstrapped\t${result.node.name}\tremote-hsr\t${result.node.endpoint}\t${result.version}\t${result.deployed ? "deployed" : "cached"}`);
  }
}


export async function nodeInspect(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node inspect <name>");
  const record = await loadNode(name);
  if (!record) throw new Error(`Unknown node: ${name}`);
  console.log(JSON.stringify(record, null, 2));
  // Surface the credential-delivery policy meaning on stderr so stdout stays
  // valid JSON for programmatic callers (APIA-93).
  const policy = authPolicyOf(record);
  console.error(dim(`auth-policy: ${policy} — ${describeAuthPolicy(policy)}`));
}


export async function nodeUpdate(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node update <name> [--endpoint addr] [--capabilities a,b] [--description \"...\"] [--ssh-command ssh] [--ssh-args=\"...\"] [--auth-policy <local-only|ephemeral-token|api-key>]");
  const patch: Parameters<typeof updateNode>[1] = {};
  if (typeof flag(parsed, "endpoint") === "string") patch.endpoint = String(flag(parsed, "endpoint"));
  if (typeof flag(parsed, "description") === "string") patch.description = String(flag(parsed, "description"));
  if (typeof flag(parsed, "ssh-command") === "string") patch.sshCommand = String(flag(parsed, "ssh-command"));
  if (typeof flag(parsed, "auth-policy") === "string") patch.authPolicy = String(flag(parsed, "auth-policy")) as AuthPolicy | "";
  if (typeof flag(parsed, "capabilities") === "string") {
    patch.capabilities = String(flag(parsed, "capabilities")).split(",").map((c) => c.trim()).filter(Boolean);
  }
  const sshArgs = parseSshArgsFlag(parsed);
  if (sshArgs) patch.sshArgs = sshArgs;
  const record = await updateNode(name, patch);
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(record.name), dim("updated")]));
  else console.log(`updated\t${record.name}`);
}


export async function nodeUnregister(parsed: Parsed) {
  const name = parsed.args[1];
  if (!name) throw new Error("Usage: hive node unregister <name> [--force]");
  const sessions = await listSessions();
  const affected = sessions.filter((record) => (record.node ?? LOCAL_NODE_NAME) === name);
  if (affected.length > 0 && !truthy(flag(parsed, "force"))) {
    throw new Error(
      `Node ${name} still has ${affected.length} bee(s): ${affected.map((record) => record.name).join(", ")}.\n` +
      `Kill or clean them first, or pass --force to unregister anyway (their records become unmanageable).`,
    );
  }
  await unregisterNode(name);
  clearSubstrateCache();
  if (isPretty()) console.log(actionLine("ok", "node", [bold(name), dim("unregistered")]));
  else console.log(`unregistered\t${name}`);
}


export async function cmdSubstrate(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case undefined:
    case "list":
    case "ls":
      return substrateList();
    default:
      throw new Error(`Unknown substrate subcommand: ${sub}\nUsage: hive substrate list`);
  }
}


export async function substrateList() {
  const nodes = await listNodes();
  const kinds = new Map<NodeRecord["kind"], number>();
  for (const node of nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
  if (!isPretty()) {
    for (const [kind, count] of kinds) console.log(`${kind}\t${count}`);
    return;
  }
  console.log(formatTable(
    [
      { header: "KIND" },
      { header: "NODES", align: "right" },
    ],
    [...kinds.entries()].sort().map(([kind, count]) => [
      nodeKindLabel(kind, "full"),
      String(count),
    ]),
  ));
}
