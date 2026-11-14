import type { ColKind } from "../core/tauri-api.service";

/** Names that say "this is what a row is called", best first. */
const EXACT = [/^name$/i, /^(full|display|user)_?name$/i, /^title$/i, /^label$/i, /^username$/i, /^email$/i, /^(code|slug|sku)$/i];
const LOOSE = [/name/i, /title/i, /email/i, /label/i, /code/i];

/**
 * The column that names a row of a table, shown next to its key in the foreign-key picker: the
 * saved choice when the table still has it, else a name-like text column, else the first text
 * column that is not the key; `null` when there is none (only the key is shown).
 */
export function labelColumn(columns: { name: string; kind: ColKind }[], key: string[], saved?: string | null): string | null {
  if (saved && columns.some((c) => c.name === saved)) return saved;
  const text = columns.filter((c) => (c.kind === "text" || c.kind === "enum") && !key.includes(c.name));
  for (const re of [...EXACT, ...LOOSE]) {
    const hit = text.find((c) => re.test(c.name));
    if (hit) return hit.name;
  }
  return text[0]?.name ?? null;
}
