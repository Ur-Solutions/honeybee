// Small helpers for `hive list` rendering. Kept separate from cli.ts so unit
// tests can import them without running cli.ts's main() side-effect.

export function shouldShowNodeColumn(nodes: { name: string }[], wideFlag: boolean): boolean {
  return wideFlag || nodes.length > 1;
}
