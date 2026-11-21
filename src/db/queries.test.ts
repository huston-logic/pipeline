import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Db } from "./db.ts";
import * as queries from "./queries.ts";
import { createTestDb, openTestDb } from "./sqlite-d1.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return db;
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

test("getSettings returns the single settings row", async () => {
  const settings = await queries.getSettings(await openTestDb());
  assert.equal(settings.id, 1);
  assert.equal(settings.timezone, "America/Los_Angeles");
  assert.equal(settings.brief_hour, 7);
  assert.equal(settings.brief_enabled, 0);
  assert.deepEqual(JSON.parse(settings.owner_emails), []);
});

test("getSettings says how to fix a database without its defaults", async () => {
  const db = await openTestDb();
  await db.prepare("DELETE FROM settings").run();
  await assert.rejects(queries.getSettings(db), /seed\/defaults\.sql/);
});

test("listStages is in board order and hides archived stages unless asked", async () => {
  const db = await openTestDb();
  const keys = (await queries.listStages(db)).map((s) => s.key);
  assert.deepEqual(keys, [
    "new_inquiry",
    "replied",
    "call_booked",
    "call_done",
    "proposal_sent",
    "won",
    "lost",
    "not_now",
  ]);
  await db.prepare("UPDATE stages SET archived = 1 WHERE key = 'not_now'").run();
  assert.ok(!(await queries.listStages(db)).some((s) => s.key === "not_now"));
  assert.ok((await queries.listStages(db, { includeArchived: true })).some((s) => s.key === "not_now"));
});

test("getContact and getDeal return the row or null", async () => {
  const db = await seededDb();
  const contact = await queries.getContact(db, "ct_seed01");
  assert.equal(contact?.name, "Pat Example");
  assert.equal(contact?.fields, "{}");
  assert.equal(await queries.getContact(db, "ct_nope"), null);
  const deal = await queries.getDeal(db, "dl_seed01");
  assert.equal(deal?.contact_id, "ct_seed01");
  assert.equal(deal?.stage_key, "call_booked");
  assert.equal(deal?.value, 1500);
  assert.equal(await queries.getDeal(db, "dl_nope"), null);
});

test("findContactByEmail ignores case and surrounding spaces", async () => {
  const db = await seededDb();
  assert.equal((await queries.findContactByEmail(db, " PAT@Example.com "))?.id, "ct_seed01");
  assert.equal(await queries.findContactByEmail(db, "nobody@example.com"), null);
});

test("searchContacts matches name, email, business or phone, case-insensitively, sorted by name", async () => {
  const db = await seededDb();
  assert.deepEqual(ids(await queries.searchContacts(db, "sample")), ["ct_seed07", "ct_seed02"]);
  assert.deepEqual(ids(await queries.searchContacts(db, "BAKERY")), ["ct_seed02"]);
  assert.deepEqual(ids(await queries.searchContacts(db, "casey@")), ["ct_seed03"]);
  assert.deepEqual(ids(await queries.searchContacts(db, "555-0104")), ["ct_seed04"]);
  assert.equal((await queries.searchContacts(db, "")).length, 8);
  assert.equal((await queries.searchContacts(db, "", { limit: 3 })).length, 3);
});

test("searchContacts treats % and _ literally and skips archived contacts unless asked", async () => {
  const db = await seededDb();
  assert.deepEqual(await queries.searchContacts(db, "%"), []);
  assert.deepEqual(await queries.searchContacts(db, "_"), []);
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = 'ct_seed02'").run();
  assert.deepEqual(ids(await queries.searchContacts(db, "sample")), ["ct_seed07"]);
  assert.deepEqual(ids(await queries.searchContacts(db, "sample", { includeArchived: true })), [
    "ct_seed07",
    "ct_seed02",
  ]);
});

test("listDeals is in stage order and filters by stage, status, contact, next date and quiet", async () => {
  const db = await seededDb();
  const all = await queries.listDeals(db);
  assert.deepEqual(ids(all), [
    "dl_seed06",
    "dl_seed02",
    "dl_seed03",
    "dl_seed01",
    "dl_seed04",
    "dl_seed05",
    "dl_seed07",
    "dl_seed08",
  ]);
  assert.deepEqual(ids(await queries.listDeals(db, { stage: "new_inquiry" })), ["dl_seed06", "dl_seed02"]);
  assert.deepEqual(ids(await queries.listDeals(db, { status: "won" })), ["dl_seed07"]);
  assert.equal((await queries.listDeals(db, { status: "open" })).length, 6);
  assert.deepEqual(ids(await queries.listDeals(db, { contactId: "ct_seed04" })), ["dl_seed04"]);
  assert.deepEqual(ids(await queries.listDeals(db, { nextAtBefore: "2026-11-21T00:00:00.000Z" })), ["dl_seed04"]);
  // Quiet: no contact since 5 days before NOW (deal 06 has none at all, so its creation counts).
  assert.deepEqual(
    ids(await queries.listDeals(db, { status: "open", lastActivityBefore: "2026-11-14T18:00:00.000Z" })),
    ["dl_seed06", "dl_seed05"],
  );
  assert.equal((await queries.listDeals(db, { limit: 2 })).length, 2);
});

test("listDeals skips archived deals unless asked", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET archived = 1 WHERE id = 'dl_seed08'").run();
  assert.ok(!ids(await queries.listDeals(db)).includes("dl_seed08"));
  assert.ok(ids(await queries.listDeals(db, { includeArchived: true })).includes("dl_seed08"));
});

test("listActivities is newest first, for a deal or for everything about a contact", async () => {
  const db = await seededDb();
  assert.deepEqual(ids(await queries.listActivities(db, { dealId: "dl_seed01" })), [
    "ac_seed04",
    "ac_seed03",
    "ac_seed02",
    "ac_seed01",
  ]);
  assert.deepEqual(ids(await queries.listActivities(db, { dealId: "dl_seed01" }, { limit: 1 })), ["ac_seed04"]);
  await db
    .prepare(
      "INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_x', 'ct_seed03', 'note', 'Contact-only note', ?, 'owner')",
    )
    .bind("2026-11-19T17:00:00.000Z")
    .run();
  assert.deepEqual(ids(await queries.listActivities(db, { contactId: "ct_seed03" })), [
    "ac_x",
    "ac_seed07",
    "ac_seed06",
  ]);
  assert.deepEqual(await queries.listActivities(db, { dealId: "dl_nope" }), []);
});

test("listTasks filters open, due before, awake (not snoozed) and by deal or contact, soonest first", async () => {
  const db = await seededDb();
  assert.equal((await queries.listTasks(db)).length, 6);
  const open = await queries.listTasks(db, { open: true });
  assert.deepEqual(ids(open), ["tk_seed02", "tk_seed04", "tk_seed01", "tk_seed03", "tk_seed05"]);
  assert.deepEqual(ids(await queries.listTasks(db, { open: false })), ["tk_seed06"]);
  const dueSoon = await queries.listTasks(db, { open: true, dueBefore: "2026-11-20T08:00:00.000Z" });
  assert.deepEqual(ids(dueSoon), ["tk_seed02", "tk_seed04", "tk_seed01"]);
  const awake = await queries.listTasks(db, {
    open: true,
    dueBefore: "2026-11-20T08:00:00.000Z",
    awakeAt: NOW.toISOString(),
  });
  assert.deepEqual(ids(awake), ["tk_seed02", "tk_seed01"]);
  assert.deepEqual(ids(await queries.listTasks(db, { dealId: "dl_seed04" })), ["tk_seed03"]);
  assert.deepEqual(ids(await queries.listTasks(db, { contactId: "ct_seed06" })), ["tk_seed05"]);
});

test("listRules lists every rule, or only active ones", async () => {
  const db = await seededDb();
  assert.deepEqual(ids(await queries.listRules(db)), ["ru_seed01", "ru_seed02"]);
  assert.deepEqual(ids(await queries.listRules(db, { activeOnly: true })), ["ru_seed01"]);
});

test("getRulebook returns every document in order, or the one named", async () => {
  const db = await openTestDb();
  assert.deepEqual(
    (await queries.getRulebook(db)).map((doc) => doc.name),
    ["leads", "voice", "pipeline", "guardrails"],
  );
  const [voice] = await queries.getRulebook(db, "voice");
  assert.match(voice?.markdown ?? "", /^# Voice/);
  assert.deepEqual(await queries.getRulebook(db, "nope"), []);
});

test("listAudit returns changes at or after `since`, newest first", async () => {
  const db = await openTestDb();
  const add = db.prepare(
    `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary)
     VALUES (?, ?, 'ai', 'update_deal', 'deals', 'dl_seed01', '{}', '{}', ?)`,
  );
  await db.batch([
    add.bind("chg_a", "2026-11-10T10:00:00.000Z", "Old change (change chg_a)"),
    add.bind("chg_b", "2026-11-18T10:00:00.000Z", "Change B (change chg_b)"),
    add.bind("chg_c", "2026-11-18T10:00:00.000Z", "Change C (change chg_c)"),
    add.bind("chg_d", "2026-11-19T09:00:00.000Z", "Change D (change chg_d)"),
  ]);
  assert.deepEqual(ids(await queries.listAudit(db, "2026-11-18T10:00:00.000Z")), ["chg_d", "chg_c", "chg_b"]);
  assert.deepEqual(ids(await queries.listAudit(db, "2026-11-18T00:00:00.000Z", { limit: 1 })), ["chg_d"]);
  assert.deepEqual(await queries.listAudit(db, "2026-11-20T00:00:00.000Z"), []);
});

test("an empty pipeline answers with empty lists, not errors", async () => {
  const db = await openTestDb();
  assert.deepEqual(await queries.listDeals(db), []);
  assert.deepEqual(await queries.listTasks(db, { open: true }), []);
  assert.deepEqual(await queries.searchContacts(db, "pat"), []);
  assert.deepEqual(await queries.listRules(db), []);
  assert.deepEqual(await queries.listActivities(db, { contactId: "ct_seed01" }), []);
  assert.deepEqual(await queries.listAudit(db, "2000-01-01T00:00:00.000Z"), []);
});
