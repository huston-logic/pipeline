import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { type Match, matchAll, matchContact, matchDeal, matchTask } from "./name-match.ts";

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

test("a match on outside text never wins or stands in alone: every candidate is listed", async () => {
  const db = await setup();
  db.exec("INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_intake', 'Pat', '[\"name\"]')");
  const pat = await matchContact(db, "Pat");
  assert.equal(pat.kind, "many");
  assert.deepEqual(ids(pat).sort(), ["ct_intake", "ct_seed01"], "the outside exact name doesn't beat the owner's Pat Example");
  const robin = await matchContact(db, "Robin");
  assert.deepEqual([robin.kind, ids(robin)], ["many", ["ct_seed02"]], "an outside name alone is still a question");
  const bakery = await matchDeal(db, "New website for Sample Bakery");
  assert.deepEqual([bakery.kind, ids(bakery)], ["many", ["dl_seed02"]], "an outside title alone is a question");
  db.exec("INSERT INTO tasks (id, contact_id, title, untrusted_fields) VALUES ('tk_out', 'ct_seed01', 'Water the plants', '[\"title\"]')");
  assert.deepEqual((await matchTask(db, "Water")).kind, "many");
});

test("more than 10 matches is too many", async () => {
  const db = await setup();
  for (let i = 1; i <= 11; i++) db.exec(`INSERT INTO contacts (id, name) VALUES ('ct_dee${i}', 'Dee Example ${i}')`);
  assert.equal((await matchContact(db, "Dee")).kind, "tooMany");
  assert.equal((await matchDeal(db, "Dee")).kind, "tooMany");
  db.exec("DELETE FROM contacts WHERE id = 'ct_dee11'");
  assert.equal((await matchContact(db, "Dee")).kind, "many");
});

test("an open task by id or by its title", async () => {
  const db = await setup();
  assert.deepEqual(ids(await matchTask(db, "tk_seed06")), ["tk_seed06"]);
  assert.deepEqual(ids(await matchTask(db, "send casey the price sheet")), ["tk_seed02"]);
  assert.deepEqual(ids(await matchTask(db, "Send")), ["tk_seed02"], "the done Send Alex task is skipped");
  assert.equal((await matchTask(db, "Water the plants")).kind, "none");
});

test("every ref of a list is matched in one D1 call, each as it would be alone", async () => {
  const db = await setup();
  db.exec("INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_intake', 'Pat', '[\"name\"]')");
  const contacts = ["Dana", "ct_gone", "  dana   SAMPLE ", "Pat", "acme example", "ample", "Robin", "", "Nobody"];
  const deals = ["dl_seed07", "cafe website AND menu", "Pat Example", "Alex", "Casey", "ct_seed03", "New website for Sample Bakery", "  "];
  const tasks = ["tk_seed06", "Send", "send casey the price sheet", "Water the plants"];
  const counted = countingDb(db);
  const all = await matchAll(counted, { contacts, deals, tasks });
  assert.equal(counted.calls, 1, counted.log.join("\n"));
  const plain = (match: Match<{ id: string }>) => ({ kind: match.kind, ids: ids(match) });
  for (const [i, ref] of contacts.entries()) assert.deepEqual(plain(all.contacts[i] ?? { kind: "none" }), plain(await matchContact(db, ref)), ref);
  for (const [i, ref] of deals.entries()) assert.deepEqual(plain(all.deals[i] ?? { kind: "none" }), plain(await matchDeal(db, ref)), ref);
  for (const [i, ref] of tasks.entries()) assert.deepEqual(plain(all.tasks[i] ?? { kind: "none" }), plain(await matchTask(db, ref)), ref);
  assert.deepEqual(ids(all.deals[5] ?? { kind: "none" }), ["dl_seed03"], "a person's id finds their one open deal");
  assert.deepEqual(plain(all.contacts[3] ?? { kind: "none" }), { kind: "many", ids: ["ct_intake", "ct_seed01"] });
  const blank = countingDb(db);
  assert.deepEqual(await matchAll(blank, { contacts: ["  "], deals: [] }), { contacts: [{ kind: "none" }], deals: [], tasks: [] });
  assert.equal(blank.calls, 0, "nothing to read");
});

test("a list's refs past 50 of a kind are read in more statements of the same batch", async () => {
  const db = await setup();
  const refs = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? "Pat" : `ct_seed0${(i % 8) + 1}`));
  const counted = countingDb(db);
  const all = await matchAll(counted, { contacts: refs });
  assert.equal(counted.calls, 1);
  for (const [i, ref] of refs.entries()) assert.deepEqual(ids(all.contacts[i] ?? { kind: "none" }), ids(await matchContact(db, ref)), `${i}: ${ref}`);
});
