// The contact import script against a recorder: a dry run by default, and with --apply one SQL file run by
// `wrangler d1 execute --file`, applied here to a real sqlite database so the result can be checked.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ContactRow } from "../src/db/db.ts";
import { createTestDb, type SqliteD1 } from "../src/db/sqlite-d1.ts";
import { STUB_ACCOUNT_ID } from "../tests/helpers/wrangler-stub.mjs";
import { importContacts, parseImportArgs } from "./import-csv.ts";
import { ROOT } from "./wrangler-run.mjs";

const NOW = new Date("2026-11-19T18:00:00.000Z");

type Call = { cmd: string[]; env: Record<string, string> };

async function harness(t: TestContext, csv: string) {
  const dir = mkdtempSync(join(tmpdir(), "import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copiesDir = join(dir, ".copies");
  const copyDir = join(copiesDir, "acme");
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "copy.json"), JSON.stringify({ name: "acme", accountId: STUB_ACCOUNT_ID, done: ["config"] }));
  const file = join(dir, "contacts.csv");
  writeFileSync(file, csv);
  const db = await createTestDb();
  db.exec(`INSERT INTO contacts (id, name, email, untrusted_fields) VALUES ('ct_pat', 'Pat Example', 'pat@example.com', '[]')`);
  const calls: Call[] = [];
  const lines: string[] = [];
  const sqlFiles: string[] = [];
  const run = (cmd: string[], opts: { env?: Record<string, string> } = {}) => {
    calls.push({ cmd, env: opts.env ?? {} });
    const fileArg = cmd.indexOf("--file");
    if (fileArg !== -1) {
      const path = join(ROOT, cmd[fileArg + 1] ?? "");
      sqlFiles.push(path);
      runFile(db, readFileSync(path, "utf8"));
      return { status: 0, stdout: "", stderr: "" };
    }
    const { rows } = db.execute(db.prepare("SELECT * FROM contacts ORDER BY rowid"));
    return { status: 0, stdout: JSON.stringify([{ results: rows, success: true }]), stderr: "" };
  };
  const deps = { run, log: (line: string) => lines.push(line), copiesDir, now: () => NOW };
  return { deps, calls, lines, file, db, copyDir, sqlFiles };
}

/** What `wrangler d1 execute --file` does locally: one batch, all or nothing. */
function runFile(db: SqliteD1, sql: string) {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const CSV = "name,email,phone,colour\r\nRobin Sample,robin@example.com,,blue\r\nSomeone,PAT@example.com,555 0101,\r\n,x@example.com,,\r\n";

test("the default is a dry run: it reads the contacts, shows the plan and writes nothing", async (t) => {
  const h = await harness(t, CSV);
  const code = await importContacts(parseImportArgs(["--file", h.file, "--copy", "acme"]), h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.length, 1);
  const cfg = relative(ROOT, join(h.copyDir, "wrangler.jsonc"));
  assert.deepEqual(h.calls[0]?.cmd, [
    "wrangler", "d1", "execute", "DB", "--remote", "-c", cfg, "--json", "--yes", "--command", "SELECT * FROM contacts ORDER BY rowid",
  ]);
  assert.deepEqual(h.calls[0]?.env, { CLOUDFLARE_ACCOUNT_ID: STUB_ACCOUNT_ID });
  const out = h.lines.join("\n");
  assert.match(out, /1 new contact, 1 filled in, 0 unchanged, 1 skipped/);
  assert.match(out, /line 2: Robin Sample <robin@example.com>/);
  assert.match(out, /line 3: contact ct_pat gets phone/);
  assert.match(out, /line 4: no name/);
  assert.match(out, /Columns not imported: colour/);
  assert.match(out, /Dry run: nothing was written/);
  assert.equal(await h.db.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n"), 0);
});

test("--apply writes one audited change through a SQL file, then removes the file", async (t) => {
  const h = await harness(t, CSV);
  const code = await importContacts(parseImportArgs(["--file", h.file, "--copy", "acme", "--apply"]), h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.length, 2);
  const [, apply] = h.calls;
  const cfg = relative(ROOT, join(h.copyDir, "wrangler.jsonc"));
  assert.deepEqual(apply?.cmd.slice(0, 7), ["wrangler", "d1", "execute", "DB", "--remote", "-c", cfg]);
  assert.deepEqual(apply?.cmd.slice(7, 8), ["--file"]);
  assert.equal(apply?.cmd.at(-1), "--yes");
  assert.ok(h.sqlFiles[0]?.startsWith(h.copyDir), "the SQL file stays in the git-ignored copy folder");
  assert.equal(existsSync(h.sqlFiles[0] ?? ""), false, "and is removed afterwards");

  const audit = await h.db.prepare("SELECT actor, tool, summary FROM audit_log").all<{ actor: string; tool: string; summary: string }>();
  assert.equal(audit.results.length, 1);
  assert.equal(audit.results[0]?.actor, "owner");
  assert.equal(audit.results[0]?.tool, "import");
  assert.match(audit.results[0]?.summary ?? "", /^Imported 1 contact and filled details on 1 \(change chg_[a-z2-7]{12}\)$/);
  const robin = await h.db.prepare("SELECT untrusted_fields FROM contacts WHERE email = 'robin@example.com'").first<ContactRow>();
  assert.deepEqual(JSON.parse(robin?.untrusted_fields ?? ""), ["name", "email"]);
  assert.ok(h.lines.some((line) => /undo_change chg_/.test(line)));
});

test("--local reads and writes the local dev database", async (t) => {
  const h = await harness(t, CSV);
  await importContacts(parseImportArgs(["--file", h.file, "--local", "--apply"]), h.deps);
  for (const call of h.calls) {
    assert.deepEqual(call.cmd.slice(4, 7), ["--local", "--persist-to", ".wrangler/state"]);
    assert.deepEqual(call.env, {});
  }
  assert.ok(h.sqlFiles[0]?.startsWith(join(ROOT, ".wrangler")), "the local SQL file goes in the git-ignored .wrangler/");
});

test("arguments: --flag=value works; a missing value, a repeat or a value on a switch is refused in plain English", () => {
  assert.deepEqual(parseImportArgs(["--file=x.csv", "--copy=acme", "--apply"]), { file: "x.csv", copy: "acme", local: false, apply: true });
  const refuse = (argv: string[], pattern: RegExp) => assert.throws(() => parseImportArgs(argv), { message: pattern }, argv.join(" "));
  refuse(["--copy", "acme", "--file"], /^--file needs a value, like --file contacts\.csv\.$/);
  refuse(["--copy", "acme", "--file", "--apply"], /^--file needs a value/);
  refuse(["--file", "x.csv", "--copy="], /^--copy needs a value/);
  refuse(["--file", "a.csv", "--file", "b.csv", "--local"], /^--file is given twice\. Give it once\.$/);
  refuse(["--file", "x.csv", "--local", "--apply", "--apply"], /^--apply is given twice/);
  refuse(["--file", "x.csv", "--local", "--apply=no"], /^--apply takes no value\. Use --apply on its own\.$/);
  refuse(["--file", "x.csv", "--local", "--remote"], /^Unknown option "--remote"\./);
});

test("nothing to import writes nothing, and bad arguments say how to fix them", async (t) => {
  const h = await harness(t, "name,email\r\nPat,pat@example.com\r\n");
  assert.equal(await importContacts(parseImportArgs(["--file", h.file, "--copy", "acme", "--apply"]), h.deps), 0);
  assert.equal(h.calls.length, 1);
  assert.ok(h.lines.some((line) => line === "Nothing to import: no new contacts and no details to fill in."));

  assert.throws(() => parseImportArgs(["--copy", "acme"]), /--file/);
  for (const bad of ["../x", "acme/../../etc", "Acme", ".copies"]) {
    assert.throws(() => parseImportArgs(["--file", "x.csv", "--copy", bad]), /can't be a copy name/, bad);
  }
  assert.throws(() => parseImportArgs(["--file", "x.csv"]), /--copy <name> or into the local dev database with --local/);
  assert.throws(() => parseImportArgs(["--file", "x.csv", "--local", "--copy", "acme"]), /--copy <name> or into the local dev database with --local/);
  assert.throws(() => parseImportArgs(["--file", "x.csv", "--local", "--remote"]), /Unknown option/);
  await assert.rejects(importContacts(parseImportArgs(["--file", join(h.copyDir, "missing.csv"), "--local"]), h.deps), /Can't read/);
});
