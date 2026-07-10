// Small helpers for `hive list` rendering. Kept separate from cli.ts so unit
// tests can import them without running cli.ts's main() side-effect.

import { LOCAL_NODE_NAME, type NodeKind } from "./node.js";
import type { SessionRecord } from "./store.js";
import type { SubstrateKind } from "./substrates/types.js";

export function shouldShowNodeColumn(nodes: { name: string }[], wideFlag: boolean): boolean {
  return wideFlag || nodes.length > 1;
}

/**
 * The effective substrate hosting a bee, for the `hive ls` SUBSTRATE column.
 *
 * Mirrors substrateFor's routing without instantiating a substrate: a
 * record-level `substrate: "hsr"` wins outright (it is local-only and routed
 * before node kinds), otherwise the bee's node kind decides. An absent
 * record.substrate and an unknown/local node fall back to "local-tmux" — the
 * back-compat default that a bare local bee runs on.
 */
export function substrateLabelFor(
  record: Pick<SessionRecord, "substrate" | "node">,
  nodeKind: (name: string) => NodeKind | undefined,
): SubstrateKind {
  if (record.substrate === "hsr") return "hsr";
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  return nodeKind(nodeName) ?? "local-tmux";
}

export type SessionDisplayNameOptions = {
  collapseDefaultId?: boolean;
};

export function sessionDisplayName(
  record: Pick<SessionRecord, "id" | "name" | "title">,
  options: SessionDisplayNameOptions = {},
): string {
  const title = normalizeDisplayTitle(record.title);
  if (title) return title;
  return options.collapseDefaultId !== false && record.name === record.id ? "=" : record.name;
}

function normalizeDisplayTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
