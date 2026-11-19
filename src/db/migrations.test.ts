import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLE_NAMES } from "./db.ts";
import { applyMigrations, applySqlFile, createTestDb, migrationFiles, SqliteD1 } from "./sqlite-d1.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function count(db: SqliteD1, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
}

async function addContact(db: SqliteD1, id: string, email: string | null = null) {
  await db.prepare("INSERT INTO contacts (id, name, email) VALUES (?, ?, ?)").bind(id, "Pat Example", email).run();
}

async function addDeal(db: SqliteD1, id: string, contactId: string, stage = "new_inquiry") {
  await db
    .prepare("INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, contactId, "Example website", stage, "2026-11-18T17:00:00.000Z")
    .run();
}

test("migrationFiles lists migrations/*.sql in order, numbered from 0001 without gaps", () => {
  const files = migrationFiles();
  assert.equal(files[0]?.name, "0001_init.sql");
  files.forEach((file, i) => assert.equal(file.number, i + 1, file.name));
});

test("from an empty database every table exists, is STRICT, and foreign keys check clean", async () => {
  const db = new SqliteD1();
  assert.deepEqual(await applyMigrations(db), migrationFiles().map((file) => file.name));
  applySqlFile(db, "seed/defaults.sql");

  const tables = (await db.prepare("PRAGMA table_list").all<{ name: string; strict: number }>()).results;
  for (const name of TABLE_NAMES) {
    const table = tables.find((t) => t.name === name);
    assert.ok(table, `${name} is missing`);
    assert.equal(table.strict, 1, `${name} is not STRICT`);
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal(await db.prepare("PRAGMA foreign_keys").first("foreign_keys"), 1);
});

test("migrations are recorded like wrangler's and are not applied twice", async () => {
  const db = new SqliteD1();
  await applyMigrations(db);
  assert.deepEqual(await applyMigrations(db), []);
  const names = (await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results;
  assert.deepEqual(
    names.map((row) => row.name),
    migrationFiles().map((file) => file.name),
  );
});

test("applyMigrations stops at upTo", async () => {
  const db = new SqliteD1();
  assert.deepEqual(await applyMigrations(db, 0), []);
  assert.deepEqual(await applyMigrations(db, 1), ["0001_init.sql"]);
});

test("defaults: settings row, eight stages in order, three rulebook documents; loading twice is harmless", async () => {
  const db = await createTestDb();
  applySqlFile(db, "seed/defaults.sql");

  const settings = await db.prepare("SELECT * FROM settings").all();
  assert.equal(settings.results.length, 1);
  assert.deepEqual(
    await db.prepare("SELECT id, timezone, brief_hour, brief_email, brief_enabled, owner_emails, version FROM settings").first(),
    {
      id: 1,
      timezone: "America/Los_Angeles",
      brief_hour: 7,
      brief_email: null,
      brief_enabled: 0,
      owner_emails: "[]",
      version: 1,
    },
  );

  const stages = (await db.prepare("SELECT key, label, kind, position, archived FROM stages ORDER BY position").all())
    .results;
  assert.deepEqual(stages, [
    { key: "new_inquiry", label: "New inquiry", kind: "open", position: 1, archived: 0 },
    { key: "replied", label: "Replied", kind: "open", position: 2, archived: 0 },
    { key: "call_booked", label: "Call booked", kind: "open", position: 3, archived: 0 },
    { key: "call_done", label: "Call done", kind: "open", position: 4, archived: 0 },
    { key: "proposal_sent", label: "Proposal sent", kind: "open", position: 5, archived: 0 },
    { key: "won", label: "Won", kind: "won", position: 6, archived: 0 },
    { key: "lost", label: "Lost", kind: "lost", position: 7, archived: 0 },
    { key: "not_now", label: "Not now", kind: "not_now", position: 8, archived: 0 },
  ]);

  const rulebook = (await db.prepare("SELECT name, markdown FROM rulebook ORDER BY name").all<{
    name: string;
    markdown: string;
  }>()).results;
  assert.deepEqual(
    rulebook.map((doc) => doc.name),
    ["guardrails", "pipeline", "voice"],
  );
  for (const doc of rulebook) assert.ok(doc.markdown.startsWith("# "), `${doc.name} starts with a heading`);

  const stage = await db.prepare("SELECT created_at, updated_at FROM stages WHERE key = 'won'").first<{
    created_at: string;
    updated_at: string;
  }>();
  assert.match(stage?.created_at ?? "", ISO);
  assert.match(stage?.updated_at ?? "", ISO);
});

test("contact emails are unique ignoring case; contacts without email are fine", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_a", "a@example.com");
  await assert.rejects(addContact(db, "ct_b", "A@example.com"), /UNIQUE constraint failed/);
  await addContact(db, "ct_c");
  await addContact(db, "ct_d");
  assert.equal(await count(db, "contacts"), 3);
});

test("a deal needs a known stage and a known contact", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_a");
  await assert.rejects(addDeal(db, "dl_a", "ct_a", "no_such_stage"), /FOREIGN KEY constraint failed/);
  await assert.rejects(addDeal(db, "dl_b", "ct_missing"), /FOREIGN KEY constraint failed/);
  await addDeal(db, "dl_c", "ct_a");
  const deal = await db.prepare("SELECT status, fields, archived, version FROM deals").first();
  assert.deepEqual(deal, { status: "open", fields: "{}", archived: 0, version: 1 });
});

test("write_guard accepts only ok = 1, so a stale version check aborts its batch", async () => {
  const db = await createTestDb();
  await assert.rejects(db.prepare("INSERT INTO write_guard (ok) VALUES (0)").run(), /CHECK constraint failed/);
  await db.prepare("INSERT INTO write_guard (ok) VALUES (1)").run();

  await addContact(db, "ct_a");
  await assert.rejects(
    db.batch([
      db.prepare("UPDATE contacts SET name = 'Robin Sample', version = version + 1 WHERE id = 'ct_a'"),
      db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM contacts WHERE id = ? AND version = ?").bind(
        "ct_a",
        7,
      ),
    ]),
    /CHECK constraint failed/,
  );
  assert.equal(await db.prepare("SELECT name FROM contacts WHERE id = 'ct_a'").first("name"), "Pat Example");
});

test("activities and tasks belong to a deal or a contact", async () => {
  const db = await createTestDb();
  await assert.rejects(
    db
      .prepare("INSERT INTO activities (id, type, summary, occurred_at, actor) VALUES ('ac_a', 'note', 'x', ?, 'owner')")
      .bind("2026-11-18T17:00:00.000Z")
      .run(),
    /CHECK constraint failed/,
  );
  await assert.rejects(db.prepare("INSERT INTO tasks (id, title) VALUES ('tk_a', 'Call back')").run(), /CHECK/);
  await addContact(db, "ct_a");
  await db.prepare("INSERT INTO tasks (id, contact_id, title) VALUES ('tk_b', 'ct_a', 'Call back')").run();
  assert.equal(await db.prepare("SELECT source FROM tasks WHERE id = 'tk_b'").first("source"), "owner");
});

test("columns are typed and checked: STRICT types, allowed values, valid JSON", async () => {
  const db = await createTestDb();
  await assert.rejects(db.prepare("UPDATE settings SET brief_hour = 'seven'").run(), /cannot store TEXT/);
  await assert.rejects(db.prepare("UPDATE settings SET brief_hour = 24").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE settings SET brief_enabled = 2").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE settings SET owner_emails = 'nope'").run(), /CHECK/);
  await assert.rejects(db.prepare("INSERT INTO settings (id) VALUES (2)").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE stages SET kind = 'maybe' WHERE key = 'won'").run(), /CHECK/);
  await addContact(db, "ct_a");
  await assert.rejects(db.prepare("UPDATE contacts SET fields = 'not json'").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE contacts SET untrusted_fields = '{}'").run(), /CHECK/);
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_a', 'deal', 'budget', 'Budget', 'money')",
      )
      .run(),
    /CHECK/,
  );
});

test("rule firings: one per fire key, and the task link clears if the task goes", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_a");
  await addDeal(db, "dl_a", "ct_a");
  await db
    .prepare(
      `INSERT INTO rules (id, type, params, description, created_by)
       VALUES ('ru_a', 'gone_quiet', '{"type":"gone_quiet","days":5}', 'Flag quiet deals', 'owner')`,
    )
    .run();
  await db.prepare("INSERT INTO tasks (id, deal_id, title, source) VALUES ('tk_a', 'dl_a', 'Nudge', 'ru_a')").run();
  const fire = "INSERT INTO rule_firings (id, rule_id, deal_id, fire_key, task_id) VALUES (?, 'ru_a', 'dl_a', 'k1', ?)";
  await db.prepare(fire).bind("rf_a", "tk_a").run();
  await assert.rejects(db.prepare(fire).bind("rf_b", null).run(), /UNIQUE constraint failed: rule_firings\.fire_key/);
  await db.prepare("DELETE FROM tasks WHERE id = 'tk_a'").run();
  assert.equal(await db.prepare("SELECT task_id FROM rule_firings WHERE id = 'rf_a'").first("task_id"), null);
});

test("0002 from the previous version: deals and tasks keep their data and get untrusted_fields '[]'", async () => {
  const db = new SqliteD1();
  assert.deepEqual(await applyMigrations(db, 1), ["0001_init.sql"]);
  applySqlFile(db, "seed/defaults.sql");
  await addContact(db, "ct_a", "pat@example.com");
  await addDeal(db, "dl_a", "ct_a");
  await db.prepare("INSERT INTO tasks (id, deal_id, title) VALUES ('tk_a', 'dl_a', 'Call back')").run();

  assert.deepEqual(await applyMigrations(db, 2), ["0002_untrusted_provenance.sql"]);
  const deal = await db.prepare("SELECT title, contact_id, untrusted_fields FROM deals WHERE id = 'dl_a'").first();
  assert.deepEqual({ ...deal }, { title: "Example website", contact_id: "ct_a", untrusted_fields: "[]" });
  const task = await db.prepare("SELECT title, deal_id, untrusted_fields FROM tasks WHERE id = 'tk_a'").first();
  assert.deepEqual({ ...task }, { title: "Call back", deal_id: "dl_a", untrusted_fields: "[]" });
  assert.equal(await db.prepare("SELECT email FROM contacts WHERE id = 'ct_a'").first("email"), "pat@example.com");
  const fkProblems = await db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fkProblems.results, []);
});

test("untrusted_fields on deals and tasks must be a JSON array", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_a");
  await addDeal(db, "dl_a", "ct_a");
  await db.prepare("INSERT INTO tasks (id, deal_id, title) VALUES ('tk_a', 'dl_a', 'Call back')").run();
  await db.prepare(`UPDATE deals SET untrusted_fields = '["title"]'`).run();
  await assert.rejects(db.prepare("UPDATE deals SET untrusted_fields = 'title'").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE tasks SET untrusted_fields = '{}'").run(), /CHECK/);
});

test("0003 from the previous version: existing data is untouched and briefs starts empty", async () => {
  const db = new SqliteD1();
  assert.deepEqual(await applyMigrations(db, 2), ["0001_init.sql", "0002_untrusted_provenance.sql"]);
  applySqlFile(db, "seed/defaults.sql");
  await addContact(db, "ct_a", "pat@example.com");
  await addDeal(db, "dl_a", "ct_a");
  await db.prepare("INSERT INTO tasks (id, deal_id, title, untrusted_fields) VALUES ('tk_a', 'dl_a', 'Call back', '[\"title\"]')").run();

  assert.deepEqual(await applyMigrations(db), ["0003_briefs.sql"]);
  assert.equal(await count(db, "briefs"), 0);
  const deal = await db.prepare("SELECT title, untrusted_fields FROM deals WHERE id = 'dl_a'").first();
  assert.deepEqual({ ...deal }, { title: "Example website", untrusted_fields: "[]" });
  const task = await db.prepare("SELECT title, untrusted_fields FROM tasks WHERE id = 'tk_a'").first();
  assert.deepEqual({ ...task }, { title: "Call back", untrusted_fields: '["title"]' });
  assert.equal(await db.prepare("SELECT brief_hour FROM settings").first("brief_hour"), 7);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("briefs: one per local date, items must be a JSON array", async () => {
  const db = await createTestDb();
  const insert = (id: string, date: string, items = "[]") =>
    db
      .prepare("INSERT INTO briefs (id, local_date, composed_at, text, items) VALUES (?, ?, '2026-11-19T15:00:00.000Z', 'x', ?)")
      .bind(id, date, items)
      .run();
  await insert("br_a", "2026-11-19");
  await assert.rejects(insert("br_b", "2026-11-19"), /UNIQUE constraint failed: briefs\.local_date/);
  await assert.rejects(insert("br_c", "2026-11-20", "{}"), /CHECK/);
  const row = await db.prepare("SELECT sent_at, send_status FROM briefs").first();
  assert.deepEqual({ ...row }, { sent_at: null, send_status: null });
});
