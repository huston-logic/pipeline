import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteD1 } from "./sqlite-d1.ts";

function people(): SqliteD1 {
  const db = new SqliteD1();
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE pets (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES people(id)) STRICT;
    INSERT INTO people (name) VALUES ('Pat Example'), ('Robin Sample');
  `);
  return db;
}

test("first() returns the first row as a plain object, null when there is none, or one column", async () => {
  const db = people();
  const row = await db.prepare("SELECT id, name FROM people ORDER BY id").first();
  assert.deepEqual(row, { id: 1, name: "Pat Example" });
  assert.equal(await db.prepare("SELECT * FROM people WHERE id = ?").bind(99).first(), null);
  assert.equal(await db.prepare("SELECT name FROM people WHERE id = ?").bind(2).first("name"), "Robin Sample");
  await assert.rejects(db.prepare("SELECT name FROM people").first("nope"), /D1_COLUMN_NOTFOUND/);
});

test("all() returns results, success and meta like D1", async () => {
  const db = people();
  const result = await db.prepare("SELECT name FROM people WHERE active = ? ORDER BY name").bind(true).all();
  assert.equal(result.success, true);
  assert.deepEqual(result.results, [{ name: "Pat Example" }, { name: "Robin Sample" }]);
  assert.equal(result.meta.changes, 0);
});

test("run() reports changes and last_row_id", async () => {
  const db = people();
  const insert = await db.prepare("INSERT INTO people (name) VALUES (?)").bind("Casey Placeholder").run();
  assert.equal(insert.success, true);
  assert.equal(insert.meta.changes, 1);
  assert.equal(insert.meta.last_row_id, 3);
  assert.equal(insert.meta.changed_db, true);
  const update = await db.prepare("UPDATE people SET active = 0").run();
  assert.equal(update.meta.changes, 3);
  const none = await db.prepare("UPDATE people SET active = 0 WHERE id = 99").run();
  assert.equal(none.meta.changes, 0);
  assert.equal(none.meta.changed_db, false);
});

test("raw() returns arrays, optionally with the column names first", async () => {
  const db = people();
  const stmt = db.prepare("SELECT id, name FROM people ORDER BY id");
  assert.deepEqual(await stmt.raw(), [
    [1, "Pat Example"],
    [2, "Robin Sample"],
  ]);
  assert.deepEqual(await stmt.raw({ columnNames: true }), [["id", "name"], [1, "Pat Example"], [2, "Robin Sample"]]);
});

test("bind() returns a new statement and refuses undefined like D1", async () => {
  const db = people();
  const base = db.prepare("SELECT name FROM people WHERE id = ?");
  const one = base.bind(1);
  const two = base.bind(2);
  assert.equal(await one.first("name"), "Pat Example");
  assert.equal(await two.first("name"), "Robin Sample");
  assert.throws(() => base.bind(undefined), /D1_TYPE_ERROR/);
  assert.throws(() => base.bind({ id: 1 }), /D1_TYPE_ERROR/);
});

test("prepare() is lazy: bad SQL fails when it runs, as a D1_ERROR", async () => {
  const db = people();
  const stmt = db.prepare("SELEC nonsense");
  await assert.rejects(stmt.all(), /D1_ERROR/);
});

test("constraint errors keep SQLite's message", async () => {
  const db = people();
  await assert.rejects(
    db.prepare("INSERT INTO people (name) VALUES (?)").bind("Pat Example").run(),
    /D1_ERROR: UNIQUE constraint failed: people\.name/,
  );
});

test("foreign keys are enforced, as in D1", async () => {
  const db = people();
  await assert.rejects(db.prepare("INSERT INTO pets (owner_id) VALUES (42)").run(), /FOREIGN KEY constraint failed/);
});

test("batch() runs every statement in order and returns one result each", async () => {
  const db = people();
  const results = await db.batch([
    db.prepare("INSERT INTO people (name) VALUES (?)").bind("Casey Placeholder"),
    db.prepare("SELECT COUNT(*) AS n FROM people"),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.meta.changes, 1);
  assert.deepEqual(results[1]?.results, [{ n: 3 }]);
});

test("batch() is atomic: when a later statement fails, earlier ones are rolled back", async () => {
  const db = people();
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO people (name) VALUES (?)").bind("Casey Placeholder"),
      db.prepare("INSERT INTO people (name) VALUES (?)").bind("Pat Example"),
    ]),
    /UNIQUE constraint failed/,
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM people").first("n"), 2);
  // The connection is usable afterwards (no transaction left open).
  await db.batch([db.prepare("INSERT INTO people (name) VALUES (?)").bind("Casey Placeholder")]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM people").first("n"), 3);
});

test("batch() refuses statements from another database", async () => {
  const a = people();
  const b = people();
  await assert.rejects(a.batch([b.prepare("SELECT 1")]), /same database/);
});
