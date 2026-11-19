// `npm run import:contacts -- --file <csv> (--copy <name> | --local [--persist-to <dir>]) [--apply]`
// Imports contacts from a CSV with a header row (name, email, phone, business, source, notes; docs/INSTALL.md).
// The default is a dry run: it reads the copy's contacts, then shows what would be created, filled in and skipped.
// --apply writes it as one audited change (actor owner, tool "import"; undo_change reverses it): a SQL file in the
// git-ignored copy folder (or .wrangler/ for --local), run by `wrangler d1 execute --file`, then removed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContactRow } from "../src/db/db.ts";
import { importChange, renderImport } from "../src/import/change.ts";
import { type ImportPlan, planImport } from "../src/import/plan.ts";
import { parseFlags, UsageError } from "./cli-args.mjs";
import { copyNameProblem, copyPaths, databaseTarget, isCopyName, makeRunner, query } from "./copies.mjs";
import { ROOT, run as defaultRun, type RunOptions, type RunResult } from "./wrangler-run.mjs";

export interface ImportOptions {
  file: string;
  copy?: string;
  local: boolean;
  persistTo?: string;
  apply: boolean;
}

export interface ImportDeps {
  run: (cmd: string[], options?: RunOptions) => RunResult;
  log: (line: string) => void;
  copiesDir: string;
  root?: string;
  now?: () => Date;
}

const SHOWN = 20;

const FLAGS = {
  values: {
    "--file": { key: "file", example: "contacts.csv" },
    "--copy": { key: "copy", example: "acme" },
    "--persist-to": { key: "persistTo", example: ".wrangler/state" },
  },
  switches: { "--apply": "apply", "--local": "local" },
};

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export function parseImportArgs(argv: string[]): ImportOptions {
  const flags = parseFlags(argv, FLAGS, "Use --file, --copy or --local, and --apply to write.");
  const options: Partial<ImportOptions> = { local: flags.local === true, apply: flags.apply === true };
  for (const key of ["file", "copy", "persistTo"] as const) {
    const value = text(flags[key]);
    if (value !== undefined) options[key] = value;
  }
  if (options.file === undefined) throw new UsageError("Name the CSV file: --file <path>.");
  if (options.copy !== undefined && !isCopyName(options.copy)) throw new UsageError(copyNameProblem(options.copy));
  if ((options.copy === undefined) === !options.local) {
    throw new UsageError("Import into one copy with --copy <name> or into the local dev database with --local.");
  }
  return options as ImportOptions;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function showPlan(plan: ImportPlan, log: (line: string) => void): void {
  log(
    `${plural(plan.create.length, "new contact")}, ${plan.merge.length} filled in, ${plan.unchanged.length} unchanged, ` +
      `${plan.skipped.length} skipped.`,
  );
  const list = <T>(title: string, items: T[], line: (item: T) => string) => {
    if (items.length === 0) return;
    log(`${title}${items.length > SHOWN ? ` (the first ${SHOWN} of ${items.length})` : ""}:`);
    for (const item of items.slice(0, SHOWN)) log(`  ${line(item)}`);
  };
  list("New contacts", plan.create, (row) => `line ${row.line}: ${row.name}${row.email ? ` <${row.email}>` : ""}`);
  list("Details filled in on contacts already on file (nothing is overwritten)", plan.merge, (row) =>
    `line ${row.line}: contact ${row.id} gets ${Object.keys(row.changes).join(", ")}`,
  );
  list("Matched, nothing to fill in", plan.unchanged, (row) => `line ${row.line}: contact ${row.id}`);
  list("Skipped", plan.skipped, (row) => `line ${row.line}: ${row.reason}`);
  if (plan.skippedColumns.length > 0) log(`Columns not imported: ${plan.skippedColumns.join(", ")}`);
}

export async function importContacts(options: ImportOptions, deps: ImportDeps): Promise<number> {
  const { root = ROOT, now = () => new Date() } = deps;
  let csv: string;
  try {
    csv = readFileSync(resolve(root, options.file), "utf8");
  } catch {
    throw new UsageError(`Can't read ${options.file}. Check the path and try again.`);
  }
  const target = databaseTarget(options, { copiesDir: deps.copiesDir, root });
  const runner = makeRunner(deps, target.accountId);
  const existing = query(runner, target, "SELECT * FROM contacts ORDER BY rowid") as ContactRow[];
  const plan = planImport(csv, existing);
  deps.log(`Import plan for ${options.local ? "the local dev database" : `the copy "${options.copy}"`}:`);
  showPlan(plan, deps.log);
  if (!options.apply) {
    deps.log("Dry run: nothing was written. Imported text is kept as outside text. Run again with --apply to import.");
    return 0;
  }

  const at = now();
  const input = importChange(plan, existing, at);
  if (input === null) {
    deps.log("Nothing to import: no new contacts and no details to fill in.");
    return 0;
  }
  const { changeId, summary, sql } = renderImport(input, at);
  const dir = options.local ? join(root, ".wrangler") : copyPaths(deps.copiesDir, options.copy).dir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `import-${changeId}.sql`);
  writeFileSync(file, sql);
  try {
    runner.must(["wrangler", "d1", "execute", "DB", ...target.flags, "--file", relative(root, file), "--yes"], {
      capture: true,
      what: "Writing the import (nothing was imported)",
    });
  } finally {
    rmSync(file, { force: true });
  }
  deps.log(summary);
  deps.log(`To reverse it, ask your AI app to run undo_change ${changeId}.`);
  return 0;
}

async function main() {
  try {
    const copiesDir = process.env.PIPELINE_COPIES_DIR ? resolve(process.env.PIPELINE_COPIES_DIR) : join(ROOT, ".copies");
    process.exitCode = await importContacts(parseImportArgs(process.argv.slice(2)), {
      run: defaultRun,
      log: (line) => console.log(line),
      copiesDir,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
