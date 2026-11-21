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
    const sql = cmd[cmd.indexOf("--command") + 1] ?? "";
    const { rows } = db.execute(db.prepare(sql));
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
  assert.equal(h.calls.length, 2);
  const cfg = relative(ROOT, join(h.copyDir, "wrangler.jsonc"));
  assert.deepEqual(h.calls[0]?.cmd, [
    "wrangler", "d1", "execute", "DB", "--remote", "-c", cfg, "--json", "--yes", "--command", "SELECT * FROM contacts ORDER BY rowid",
  ]);
  assert.deepEqual(h.calls[1]?.cmd.slice(-2), ["--command", "SELECT * FROM field_defs ORDER BY rowid"]);
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
  assert.equal(h.calls.length, 3);
  const [, , apply] = h.calls;
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
  assert.deepEqual(parseImportArgs(["--file=x.csv", "--copy=acme", "--apply"]), {
    file: "x.csv",
    copy: "acme",
    local: false,
    apply: true,
    asLeads: false,
    allowDuplicates: false,
  });
  const refuse = (argv: string[], pattern: RegExp) => assert.throws(() => parseImportArgs(argv), { message: pattern }, argv.join(" "));
  refuse(["--copy", "acme", "--file"], /^--file needs a value, like --file contacts\.csv\.$/);
  refuse(["--copy", "acme", "--file", "--apply"], /^--file needs a value/);
  refuse(["--file", "x.csv", "--copy="], /^--copy needs a value/);
  refuse(["--file", "a.csv", "--file", "b.csv", "--local"], /^--file is given twice\. Give it once\.$/);
  refuse(["--file", "x.csv", "--local", "--apply", "--apply"], /^--apply is given twice/);
  refuse(["--file", "x.csv", "--local", "--apply=no"], /^--apply takes no value\. Use --apply on its own\.$/);
  refuse(["--file", "x.csv", "--local", "--remote"], /^Unknown option "--remote"\./);
});

const LEAD_CSV = [
  "name,email,business,Role,lead_status",
  "Robin Sample,robin@example.com,Fresh Co,Owner,",
  "Casey,,Sample Bakery,,",
  "Jordan,,Fresh Co,,hot",
].join("\r\n");

test("--as leads: the dry run lists possible duplicates by line and id only, then --apply creates New leads", async (t) => {
  const h = await harness(t, LEAD_CSV);
  h.db.exec(`UPDATE contacts SET business = 'sample bakery' WHERE id = 'ct_pat'`);
  h.db.exec(`INSERT INTO field_defs (id, entity, key, label, type, archived, version, created_at, updated_at)
    VALUES ('fd_1', 'contact', 'role', 'Role', 'text', 0, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  const dry = parseImportArgs(["--file", h.file, "--copy", "acme", "--as", "leads"]);
  assert.equal(dry.asLeads, true);
  await importContacts(dry, h.deps);
  const out = h.lines.join("\n");
  assert.match(out, /1 new contact, 0 filled in, 0 unchanged, 1 skipped, 1 possible duplicate/);
  assert.match(out, /line 3: possible duplicate of contact ct_pat/);
  assert.doesNotMatch(out, /Casey.*ct_pat|Sample Bakery/);
  assert.match(out, /line 4: lead_status isn't a lead status/);
  assert.equal(await h.db.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n"), 0);

  const apply = await harness(t, LEAD_CSV);
  apply.db.exec(`UPDATE contacts SET business = 'sample bakery' WHERE id = 'ct_pat'`);
  apply.db.exec(`INSERT INTO field_defs (id, entity, key, label, type, archived, version, created_at, updated_at)
    VALUES ('fd_1', 'contact', 'role', 'Role', 'text', 0, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  const both = parseImportArgs(["--file", apply.file, "--copy", "acme", "--as", "leads", "--allow-duplicates", "--apply"]);
  assert.equal(both.allowDuplicates, true);
  await importContacts(both, apply.deps);
  const rows = (await apply.db.prepare("SELECT name, lead_status, fields FROM contacts WHERE id <> 'ct_pat' ORDER BY rowid").all<{
    name: string;
    lead_status: string | null;
    fields: string;
  }>()).results;
  assert.deepEqual(rows.map((r) => [r.name, r.lead_status]), [["Robin Sample", "new"], ["Casey", "new"]]);
  assert.equal(rows[0]?.fields, '{"role":"Owner"}');
});

test("an unknown --as value is refused in plain English", () => {
  assert.throws(() => parseImportArgs(["--file", "x.csv", "--local", "--as", "deals"]), { message: /^--as can only be "leads"/ });
  assert.throws(() => parseImportArgs(["--file", "x.csv", "--local", "--as"]), /--as needs a value/);
});

test("nothing to import writes nothing, and bad arguments say how to fix them", async (t) => {
  const h = await harness(t, "name,email\r\nPat,pat@example.com\r\n");
  assert.equal(await importContacts(parseImportArgs(["--file", h.file, "--copy", "acme", "--apply"]), h.deps), 0);
  assert.equal(h.calls.length, 2);
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
