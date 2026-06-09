// Small helpers for `hive list` rendering. Kept separate from cli.ts so unit
// tests can import them without running cli.ts's main() side-effect.

import type { SessionRecord } from "./store.js";

export function shouldShowNodeColumn(nodes: { name: string }[], wideFlag: boolean): boolean {
  return wideFlag || nodes.length > 1;
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
