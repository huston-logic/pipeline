import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { dealsInView, peopleInView } from "./view-read.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const TZ = "America/Los_Angeles";

/** Five fake people (two Partners, one an Architect), their deals, activities and tasks. */
async function seeded(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(`
    INSERT INTO person_substatuses (id, status_key, key, label, position) VALUES ('partner.architect', 'partner', 'architect', 'Architect', 1);
    INSERT INTO contacts (id, name, email, business, source, fields, untrusted_fields, person_status, sub_status, created_at) VALUES
      ('ct_a', 'Ann Example', 'ann@example.com', 'Alder Architects', 'Referral', '{"budget":1500}', '["name"]', 'partner', 'architect', '2026-11-01T10:00:00.000Z'),
      ('ct_b', 'Bo Example', 'bo@example.org', NULL, ' referral ', '{"budget":900,"role":"Owner"}', '[]', 'partner', NULL, '2026-11-02T10:00:00.000Z'),
      ('ct_c', 'Cy Example', 'cy@example.net', 'Cedar Row', 'trade show', '{"role":"owner"}', '[]', 'contact', NULL, '2026-11-03T10:00:00.000Z'),
      ('ct_d', 'Di Example', 'di@example.com', 'Smith & Co', 'referral', '{}', '[]', 'contact', NULL, '2026-11-04T10:00:00.000Z');
    INSERT INTO contacts (id, name, email, archived, person_status) VALUES ('ct_gone', 'Gone Example', 'gone@example.com', 1, 'partner');
    INSERT INTO deals (id, contact_id, title, stage_key, status, value, next_at, fields, stage_entered_at, created_at) VALUES
      ('dl_1', 'ct_a', 'Studio fit-out', 'replied', 'open', 5000, '2026-11-18T17:00:00.000Z', '{"project_type":"Commercial"}', '2026-11-09T18:00:00.000Z', '2026-11-05T10:00:00.000Z'),
      ('dl_2', 'ct_c', 'Barn survey', 'new_inquiry', 'open', NULL, NULL, '{}', '2026-11-17T18:00:00.000Z', '2026-11-06T10:00:00.000Z'),
      ('dl_3', 'ct_d', 'Office mezzanine', 'proposal_sent', 'open', 12000, '2026-11-25T17:00:00.000Z', '{"project_type":"commercial"}', '2026-11-15T18:00:00.000Z', '2026-11-07T10:00:00.000Z'),
      ('dl_4', 'ct_c', 'Old shed', 'won', 'won', 800, NULL, '{}', '2026-10-01T18:00:00.000Z', '2026-09-01T10:00:00.000Z');
    INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at, archived) VALUES ('dl_5', 'ct_d', 'Archived deal', 'replied', '2026-11-01T00:00:00.000Z', 1);
    INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_1', 'ct_b', 'call', 'Called Bo.', '2026-11-18T10:00:00.000Z', 'owner');
    INSERT INTO activities (id, deal_id, type, summary, occurred_at, actor) VALUES ('ac_2', 'dl_1', 'email', 'Emailed Ann.', '2026-11-10T10:00:00.000Z', 'owner');
    INSERT INTO tasks (id, contact_id, title, due_at) VALUES ('tk_1', 'ct_b', 'Send the plans', '2026-11-21T17:00:00.000Z');
    INSERT INTO tasks (id, deal_id, title, due_at) VALUES ('tk_2', 'dl_1', 'Chase', '2026-11-20T17:00:00.000Z');
  `);
  return db;
}

const ids = (list: { items: { id: string }[] }) => list.items.map((item) => item.id);

test("a people view: status, sub-status, source (case and outer spaces ignored), custom fields and search narrow it", async () => {
  const db = await seeded();
  const byName = { key: "name", dir: "asc" } as const;
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, byName)), ["ct_a", "ct_b", "ct_c", "ct_d"], "archived people are left out");
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { person_status: "partner" }, byName)), ["ct_a", "ct_b"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { person_status: "partner", sub_status: "architect" }, byName)), ["ct_a"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { source: "REFERRAL" }, byName)), ["ct_a", "ct_b", "ct_d"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { fields: { budget: 1500 } }, byName)), ["ct_a"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { fields: { role: "OWNER" } }, byName)), ["ct_b", "ct_c"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { q: "smith" }, byName)), ["ct_d"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { q: "%" }, byName)), [], "% is plain text");
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, { person_status: "nobody" }, byName)), []);
});

test("a people view's sorts put people with nothing to sort by last, and items carry labels and outside fields", async () => {
  const db = await seeded();
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, { key: "name", dir: "desc" })), ["ct_d", "ct_c", "ct_b", "ct_a"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, { key: "business", dir: "asc" })), ["ct_a", "ct_c", "ct_d", "ct_b"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, { key: "last_activity", dir: "desc" })), ["ct_b", "ct_a", "ct_c", "ct_d"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, { key: "next_task", dir: "asc" })), ["ct_a", "ct_b", "ct_c", "ct_d"]);
  assert.deepEqual(ids(await peopleInView(db, NOW, TZ, {}, { key: "created", dir: "desc" })), ["ct_d", "ct_c", "ct_b", "ct_a"]);
  const [ann] = (await peopleInView(db, NOW, TZ, { person_status: "partner" }, { key: "name", dir: "asc" })).items;
  assert.deepEqual(
    [ann?.personStatusLabel, ann?.subStatusLabel, ann?.lastActivityAt, ann?.nextTaskAt, ann?.untrusted_fields, ann?.fields],
    ["Partner", "Architect", "2026-11-10T10:00:00.000Z", "2026-11-20T17:00:00.000Z", ["name"], { budget: 1500 }],
  );
});

test("a view shows at most its limit, with the total before the limit", async () => {
  const db = await seeded();
  const list = await peopleInView(db, NOW, TZ, {}, { key: "name", dir: "asc" }, 2);
  assert.deepEqual([ids(list), list.total], [["ct_a", "ct_b"], 4]);
  assert.deepEqual(await peopleInView(db, NOW, TZ, { q: "nobody" }, { key: "name", dir: "asc" }), { items: [], total: 0 });
  assert.equal((await dealsInView(db, NOW, TZ, {}, { key: "value", dir: "desc" }, 1)).total, 3);
});

test("a deals view: open deals unless it names a stage (closed ones too), the person's source, deal fields and search", async () => {
  const db = await seeded();
  const longest = { key: "days_in_stage", dir: "desc" } as const;
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, longest)), ["dl_1", "dl_3", "dl_2"], "open, not archived, longest in stage first");
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, { stage: "won" }, longest)), ["dl_4"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, { source: "referral" }, longest)), ["dl_1", "dl_3"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, { fields: { project_type: "Commercial" } }, longest)), ["dl_1", "dl_3"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, { q: "barn" }, longest)), ["dl_2"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, { q: "cedar" }, longest)), ["dl_2"], "the person's company too");

  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, { key: "days_in_stage", dir: "asc" })), ["dl_2", "dl_3", "dl_1"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, { key: "value", dir: "desc" })), ["dl_3", "dl_1", "dl_2"], "no value goes last");
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, { key: "value", dir: "asc" })), ["dl_1", "dl_3", "dl_2"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, { key: "next_date", dir: "asc" })), ["dl_1", "dl_3", "dl_2"]);
  assert.deepEqual(ids(await dealsInView(db, NOW, TZ, {}, { key: "created", dir: "desc" })), ["dl_3", "dl_2", "dl_1"]);

  const [studio] = (await dealsInView(db, NOW, TZ, { q: "studio" }, longest)).items;
  assert.deepEqual(
    [studio?.contactName, studio?.stageLabel, studio?.daysInStage, studio?.overdue, studio?.untrusted_fields],
    ["Ann Example", "Replied", 10, true, ["contactName"]],
  );
});
