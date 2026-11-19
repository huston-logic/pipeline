// Renders bound statements (src/services/change.ts SqlStatement) as literal SQL, for a file that
// `wrangler d1 execute --file` runs. Used by the CSV import, so an import writes exactly the statements commitChange
// would bind. Only the value types the services bind are accepted; anything else is refused, never guessed.
import type { SqlStatement } from "../services/change.ts";

/** D1's maximum SQL statement length. */
export const MAX_STATEMENT_BYTES = 100_000;

export function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new Error("A text value holds a NUL character, which SQL text can't carry.");
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error(`The number ${value} can't be written exactly as SQL.`);
      return String(value === 0 ? 0 : value);
    }
    return String(value);
  }
  throw new Error(`A ${typeof value} value can't be written as SQL; only text, numbers and null can.`);
}

/** The statement with each `?` outside quoted text replaced by its value, ending in ";". */
export function renderStatement({ sql, params }: SqlStatement): string {
  let out = "";
  let next = 0;
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      if (next < params.length) out += sqlLiteral(params[next]);
      next += 1;
    } else {
      out += ch;
    }
  }
  if (next !== params.length) {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    throw new Error(`A statement has ${plural(next, "placeholder")} but ${plural(params.length, "value")}.`);
  }
  return `${out};`;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** One statement per line group, each checked against D1's statement size limit. */
export function renderScript(statements: readonly SqlStatement[]): string {
  return statements
    .map((statement) => {
      const text = renderStatement(statement);
      const size = bytes(text);
      if (size > MAX_STATEMENT_BYTES) {
        throw new Error(
          `This import is too large for one change: one statement would be ${Math.ceil(size / 1000)} KB, and D1 ` +
            `allows ${MAX_STATEMENT_BYTES / 1000} KB. Split the CSV into smaller files and import each one.`,
        );
      }
      return `${text}\n`;
    })
    .join("");
}
