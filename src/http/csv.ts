// CSV for the export (RFC 4180): a header row, CRLF after every record, quotes doubled, and a field quoted when it holds
// a comma, a quote, CR or LF. Text cells that a spreadsheet would run as a formula get a leading apostrophe (decision
// 0013). parseCsv reads the same format back (the round-trip tests, and the CSV import in task 11). Import-free.

const NEEDS_QUOTES = /[",\r\n]/;
// The characters OWASP lists for CSV injection: a spreadsheet treats a cell starting with them as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return quote(FORMULA_START.test(text) ? `'${text}` : text);
}

/**
 * Rows as CSV. The header is `columns` when given (so an empty table keeps its header), otherwise every key in the
 * order it first appears. No rows and no columns give "".
 */
export function toCsv(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  const names = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (names.length === 0) return "";
  return `${names.map(quote).join(",")}\r\n${csvLines(rows.map((row) => names.map((name) => row[name])))}`;
}

/**
 * Rows of cells as CSV records, each ending in CRLF, quoted and formula-guarded like toCsv's: the rows an MCP import
 * sends, kept in the same format as an uploaded file (decision 0039). An empty row is an empty line.
 */
export function csvLines(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => `${row.map(cell).join(",")}\r\n`).join("");
}

/** Records as arrays of fields. Accepts CRLF, LF or CR line ends and one byte order mark at the start of the file. */
export function parseCsv(input: string): string[][] {
  return parseCsvRecords(input).map((record) => record.fields);
}

export interface CsvRecord {
  /** The 1-based line of the file the record starts on (a quoted field can span lines). */
  line: number;
  fields: string[];
}

/** parseCsv, with the line each record starts on, so an import can say which line it skipped. */
export function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  // Something was read since the last record ended, so a last line without a line end still counts.
  let open = false;
  let line = 1;
  let startLine = 1;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push({ line: startLine, fields: record });
    record = [];
    open = false;
  };
  /** Counts a line break at i (CRLF as one) and returns its length. */
  const lineBreak = (ch: string) => {
    line += 1;
    return ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (!open) startLine = line;
    open = true;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i += 1;
      } else if (ch === "\r" || ch === "\n") {
        const size = lineBreak(ch);
        field += text.slice(i, i + size);
        i += size;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\r" || ch === "\n") {
      endRecord();
      i += lineBreak(ch);
      continue;
    } else field += ch;
    i += 1;
  }
  if (quoted) throw new Error("The CSV has a quote that is never closed. Check the file and try again.");
  if (open) endRecord();
  return records;
}
