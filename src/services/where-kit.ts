// Pieces of a WHERE clause shared by the saved-view reads (view-read.ts) and the projects list (project-read.ts).

export type Where = { clauses: string[]; params: unknown[] };

/** A custom field holds the value: a number exactly, anything else as text ignoring (ASCII) case, as search_contacts. */
export function fieldMatch(where: Where, column: string, fields: Record<string, string | number> | undefined): void {
  for (const [key, value] of Object.entries(fields ?? {})) {
    const path = `$."${key}"`;
    if (typeof value === "number") where.clauses.push(`json_extract(${column}, ?) = ?`);
    else where.clauses.push(`lower(CAST(json_extract(${column}, ?) AS TEXT)) = lower(?)`);
    where.params.push(path, value);
  }
}
