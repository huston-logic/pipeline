import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { type Match, matchContact, matchDeal, matchTask } from "./name-match.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(
    "INSERT INTO contacts (id, name, email, business) VALUES " +
      "('ct_dana1', 'Dana Example', 'dana@example.com', 'Acme  Example'), " +
      "('ct_dana2', 'Dana  Sample', 'dana.sample@example.org', NULL), " +
      "('ct_gone', 'Danielle Example', NULL, NULL)",
  );
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_gone'");
  return db;
}

const ids = <T extends { id: string }>(match: Match<T>) =>
  match.kind === "one" ? [match.row.id] : match.kind === "many" ? match.rows.map((row) => row.id) : [];

test("a contact by id, archived or not", async () => {
  const db = await setup();
  assert.deepEqual(ids(await matchContact(db, " ct_seed01 ")), ["ct_seed01"]);
  assert.equal((await matchContact(db, "ct_gone")).kind, "one");
});

test("an exact name wins, ignoring case and extra spaces", async () => {
  const db = await setup();
  assert.deepEqual(ids(await matchContact(db, "  dana   SAMPLE ")), ["ct_dana2"]);
  assert.deepEqual(ids(await matchContact(db, "pat example")), ["ct_seed01"]);
});

test("a whole word or word prefix of the name, or the business", async () => {
  const db = await setup();
  const dana = await matchContact(db, "Dana");
  assert.equal(dana.kind, "many");
  assert.deepEqual(ids(dana), ["ct_dana1", "ct_dana2"], "archived Danielle is skipped");
  assert.deepEqual(ids(await matchContact(db, "Placeh")), ["ct_seed03"]);
  assert.deepEqual(ids(await matchContact(db, "acme example")), ["ct_dana1"], "the business, spaces collapsed");
  assert.deepEqual(ids(await matchContact(db, "ample")), [], "not inside a word");
  assert.equal((await matchContact(db, "Nobody")).kind, "none");
  assert.equal((await matchContact(db, "   ")).kind, "none");
  assert.equal((await matchContact(db, "100%")).kind, "none");
});

test("a deal by id, exact title, or a person with exactly one open deal", async () => {
  const db = await setup();
  assert.deepEqual(ids(await matchDeal(db, "dl_seed07")), ["dl_seed07"]);
  assert.deepEqual(ids(await matchDeal(db, "cafe website AND menu")), ["dl_seed05"]);
  assert.deepEqual(ids(await matchDeal(db, "Pat")), ["dl_seed01"]);
  assert.equal((await matchDeal(db, "Alex")).kind, "none", "Alex's only deal is won");
  db.exec("INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ('dl_pat2', 'ct_seed01', 'Second site', 'new_inquiry', '2026-11-19T18:00:00.000Z')");
  assert.deepEqual(ids(await matchDeal(db, "Pat Example")), ["dl_seed01", "dl_pat2"]);
});

test("an open task by id or by its title", async () => {
  const db = await setup();
  assert.deepEqual(ids(await matchTask(db, "tk_seed06")), ["tk_seed06"]);
  assert.deepEqual(ids(await matchTask(db, "send casey the price sheet")), ["tk_seed02"]);
  assert.deepEqual(ids(await matchTask(db, "Send")), ["tk_seed02"], "the done Send Alex task is skipped");
  assert.equal((await matchTask(db, "Water the plants")).kind, "none");
});
