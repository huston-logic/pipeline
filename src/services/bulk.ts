// How a big change is cut into statements D1 accepts (decision 0035). D1 allows 100 KB per statement and 100 bound
// parameters, and the CSV import renders its statements as literal SQL for `wrangler d1 execute --file`, so a JSON
// parameter is kept to CHUNK_BYTES measured as it would be written there: UTF-8 bytes, plus one per apostrophe (SQL
// doubles each one in a quoted literal). Pure: nothing here touches a database.
import type { Row } from "./change.ts";

/** The most a JSON parameter (or its SQL literal) may hold, leaving room under D1's 100 KB for the statement around it. */
export const CHUNK_BYTES = 90_000;

const encoder = new TextEncoder();
const NON_ASCII = /[\u0080-￿]/;

/** The size of `text` as a quoted SQL literal's content: UTF-8 bytes, plus one for each apostrophe SQL doubles. */
export function sqlBytes(text: string): number {
  let quotes = 0;
  for (let i = text.indexOf("'"); i !== -1; i = text.indexOf("'", i + 1)) quotes += 1;
  // Plain ASCII is one byte a character; encoding is only needed (and only paid for) when there is more.
  return (NON_ASCII.test(text) ? encoder.encode(text).byteLength : text.length) + quotes;
}

/**
 * `items` in order, cut so each chunk written as a JSON array (brackets and commas counted) measures at most `max`.
 * `bytes` is one item's own size. An item that can't fit even alone is refused, never cut.
 */
export function chunkBy<T>(items: readonly T[], bytes: (item: T) => number, max = CHUNK_BYTES): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const item of items) {
    const cost = bytes(item) + 1;
    if (2 + cost > max) {
      throw new Error(`One record is too large for one statement (${Math.ceil(cost / 1000)} KB; the most is ${Math.floor(max / 1000)} KB).`);
    }
    if (current.length > 0 && size + cost > max) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Rows cut so `JSON.stringify(chunk)` measures at most `max` as a SQL literal. */
export function chunkRows(rows: Row[], max = CHUNK_BYTES): Row[][] {
  return chunkBy(rows, (row) => sqlBytes(JSON.stringify(row)), max);
}
