// The Deals import module (decision 0037): who each deal is for, invariant 1 in the same change, closed deals only
// when confirmed, an id that matches a deal fills it in, and nothing from the file in a reason or a summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, ContactRow, DealRow } from "../../db/db.ts";
import { listFieldDefs } from "../../db/queries.ts";
import { createTestDb, type SqliteD1 } from "../../db/sqlite-d1.ts";
import { commitChange } from "../../services/change.ts";
import { undoChange } from "../../services/undo.ts";
import { IMPORT_ACTOR } from "../change.ts";
import { mapCsv, planRows } from "../engine.ts";
import { dealsOnFile } from "../load.ts";
import { closedSentence, dealsModule } from "./deals.ts";

const NOW = new Date("2026-11-23T18:00:00.000Z");
const LATER = new Date("2026-11-23T19:00:00.000Z");

async function withPeople(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(`INSERT INTO contacts (id, name, email, business, untrusted_fields, lead_status, lead_status_at, created_at, updated_at, person_status, sub_status) VALUES
    ('ct_lead', 'Lee Lead', 'lee@example.com', 'Lead Bakery', '[]', 'contacted', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'lead', 'contacted'),
    ('ct_pat', 'Pat Example', 'pat@example.com', 'Example Plumbing', '[]', NULL, NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'contact', NULL),
    ('ct_gone', 'Gail Gone', 'gail@example.com', NULL, '[]', NULL, NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'contact', NULL)`);
  db.exec("UPDATE contacts SET archived = 1 WHERE id = 'ct_gone'");
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, value, stage_entered_at, untrusted_fields) VALUES
    ('dl_onfile', 'ct_pat', 'Boiler page', 'replied', NULL, '2026-11-02T00:00:00.000Z', '[]')`);
  return db;
}

async function plan(db: SqliteD1, csv: string, closedAsHistory = false) {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const { rows } = mapCsv(dealsModule, csv, fieldDefs);
  const ctx = await dealsOnFile(db, rows);
  return { ctx, plan: planRows(dealsModule, rows, ctx, { closedAsHistory, fieldDefs }) };
}

const contact = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
const dealsOf = async (db: SqliteD1) => (await db.prepare("SELECT * FROM deals ORDER BY rowid").all<DealRow>()).results;

test("deals: a new person is created and a lead gets Qualified in the same change", async () => {
  const db = await withPeople();
  const csv = [
    "title,email,name,business,stage,value,next_step,next_at",
    "Website for the bakery,LEE@example.com,,,Replied,\"$1,200\",Send the quote,2026-11-30",
    "Shop sign,nadia@example.net,Nadia Fenwick,Fenwick Joinery,,450,,",
    "Second sign,,nadia fenwick,fenwick  joinery,new_inquiry,,,",
  ].join("\r\n");
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.skipped, []);
  assert.equal(planned.create.length, 3);
  assert.equal(planned.people.length, 1, "the second row finds the person the first one adds, by name and account");
  assert.deepEqual(planned.qualify, ["ct_lead"]);
  const input = dealsModule.change(planned, ctx, NOW);
  assert.ok(input);
  const result = await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  assert.equal(result.summary, `Imported 3 deals and filled details on 0; added 1 contact; 1 lead is now Qualified (change ${result.changeId})`);
  const audits = (await db.prepare("SELECT * FROM audit_log").all<AuditRow>()).results;
  assert.equal(audits.length, 1, "one change");
  assert.deepEqual([audits[0]?.actor, audits[0]?.tool], ["owner", "import"]);

  const lee = await contact(db, "ct_lead");
  assert.deepEqual([lee?.lead_status, lee?.lead_status_at], ["qualified", NOW.toISOString()]);
  const nadia = await db.prepare("SELECT * FROM contacts WHERE email = 'nadia@example.net'").first<ContactRow>();
  assert.deepEqual(
    [nadia?.name, nadia?.business, nadia?.lead_status, JSON.parse(nadia?.untrusted_fields ?? "")],
    ["Nadia Fenwick", "Fenwick Joinery", null, ["name", "email", "business"]],
    "a new person with a deal is a contact, not a lead (add_deal), and outside text",
  );
  const added = (await dealsOf(db)).filter((deal) => deal.id !== "dl_onfile");
  assert.deepEqual(
    added.map((deal) => [deal.contact_id === nadia?.id ? "nadia" : deal.contact_id, deal.stage_key, deal.status, deal.value, deal.next_step, deal.next_at]),
    [
      ["ct_lead", "replied", "open", 1200, "Send the quote", "2026-11-30T08:00:00.000Z"],
      ["nadia", "new_inquiry", "open", 450, null, null],
      ["nadia", "new_inquiry", "open", null, null, null],
    ],
  );
  for (const deal of added) {
    assert.equal(deal.stage_entered_at, NOW.toISOString());
    assert.ok((JSON.parse(deal.untrusted_fields) as string[]).includes("title"), "the deal's own values are outside text");
  }
  assert.deepEqual(JSON.parse(added[0]?.untrusted_fields ?? ""), ["title", "value", "next_step", "next_at"]);

  // One undo takes back the deals, the new person and the Qualified.
  await undoChange({ db, now: LATER, actor: "owner", tool: "undo_change" }, result.changeId);
  assert.equal((await contact(db, "ct_lead"))?.lead_status, "contacted");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'nadia@example.net'").first("n"), 0);
  assert.equal((await dealsOf(db)).length, 1);
});

test("deals: 3 Won rows are counted and skipped unless confirmed", async () => {
  const db = await withPeople();
  const csv = [
    "title,contact_id,stage_key,status",
    "Old site,ct_pat,won,won",
    "Older site,ct_pat,Won,",
    "Oldest site,ct_lead,,won",
    "Lost one,ct_pat,lost,lost",
    "Open one,ct_lead,replied,open",
  ].join("\r\n");
  const unconfirmed = (await plan(db, csv)).plan;
  assert.deepEqual(unconfirmed.closed.map((row) => [row.line, row.stageKey]), [[2, "won"], [3, "won"], [4, "won"], [5, "lost"]]);
  assert.equal(closedSentence(unconfirmed.closed, (await plan(db, csv)).ctx.stages), "3 deals come in as Won, 1 as Lost");
  assert.deepEqual(unconfirmed.skipped, [2, 3, 4, 5].map((line) => ({ line, reason: "closed deal, not confirmed" })));
  assert.deepEqual(unconfirmed.create.map((row) => row.line), [6]);
  assert.deepEqual(unconfirmed.qualify, ["ct_lead"], "the open deal qualifies the lead");

  const { ctx, plan: confirmed } = await plan(db, csv, true);
  assert.deepEqual(confirmed.skipped, []);
  assert.deepEqual(confirmed.create.map((row) => [row.line, row.stageKey, row.status]), [
    [2, "won", "won"],
    [3, "won", "won"],
    [4, "won", "won"],
    [5, "lost", "lost"],
    [6, "replied", "open"],
  ]);
  const input = dealsModule.change(confirmed, ctx, NOW);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const won = (await dealsOf(db)).filter((deal) => deal.status === "won");
  assert.equal(won.length, 3);
  assert.ok(won.every((deal) => deal.stage_entered_at === NOW.toISOString()), "a closed deal enters its stage at the import");

  // A closed deal alone never qualifies a lead: invariant 1 is about open deals.
  const onlyClosed = (await plan(await withPeople(), "title,contact_id,stage\r\nOld site,ct_lead,Lost\r\n", true)).plan;
  assert.deepEqual(onlyClosed.qualify, []);
  assert.equal(closedSentence([], ctx.stages), "");
});

test("deals: an id that matches a deal fills its empty values only; an unmatched deal id is kept; deals never merge otherwise", async () => {
  const db = await withPeople();
  const csv = [
    "id,title,contact_id,stage,value,next_step,version,stage_entered_at",
    "dl_onfile,Another title,ct_lead,won,300,Call back,7,2026-01-01",
    "dl_fromcopy,Boiler page,ct_pat,,,,1,2026-01-01",
    "dl_fromcopy,Boiler page again,ct_pat,,,,1,2026-01-01",
    "99,Boiler page,ct_pat,,,,1,2026-01-01",
  ].join("\r\n");
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.merge, [{ id: "dl_onfile", line: 2, changes: { value: 300, next_step: "Call back" } }]);
  assert.deepEqual(planned.create.map((row) => [row.line, row.id]), [[3, "dl_fromcopy"], [5, null]], "the same title makes a new deal");
  assert.deepEqual(planned.skipped, [{ line: 4, reason: "the same id as line 3" }]);
  assert.deepEqual(planned.qualify, [], "a merge never moves the deal or its person");
  const input = dealsModule.change(planned, ctx, NOW);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const onFile = (await dealsOf(db)).find((deal) => deal.id === "dl_onfile");
  assert.deepEqual(
    [onFile?.title, onFile?.stage_key, onFile?.contact_id, onFile?.value, onFile?.next_step, JSON.parse(onFile?.untrusted_fields ?? "")],
    ["Boiler page", "replied", "ct_pat", 300, "Call back", ["value", "next_step"]],
  );
  assert.ok((await dealsOf(db)).some((deal) => deal.id === "dl_fromcopy"));

  const again = (await plan(db, csv)).plan;
  assert.deepEqual(again.unchanged.map((row) => row.line), [2, 3], "the same file again changes nothing it already filled");
});

test("deals: skip reasons name columns, stages and ids, never a value from the file", async () => {
  const db = await withPeople();
  const csv = [
    "title,contact_id,email,name,stage,status,value,next_at",
    ",ct_pat,,,,,,",
    "Secret title,ct_pat,,,Imaginary stage,,,",
    "Secret title,ct_pat,,,Replied,won,,",
    "Secret title,ct_pat,,,,sideways,,",
    "Secret title,ct_pat,,,,,lots,",
    "Secret title,ct_pat,,,,,-5,",
    "Secret title,ct_pat,,,,,,next tuesday",
    "Secret title,ct_gone,,,,,,",
    "Secret title,,gail@example.com,,,,,",
    "Secret title,,not-an-email,Secret Person,,,,",
    "Secret title,,,,,,,",
    "Secret title,ct_unknown,,,,,,",
  ].join("\r\n");
  const { plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.skipped, [
    { line: 2, reason: "no title" },
    { line: 3, reason: "stage isn't one of your stages: New inquiry, Replied, Call booked, Call done, Proposal sent, Won, Lost, Not now" },
    { line: 4, reason: "status doesn't match the stage (Replied is an open stage)" },
    { line: 5, reason: "status isn't a deal status. Use open, won, lost or not_now" },
    { line: 6, reason: "value needs a number of 0 or more" },
    { line: 7, reason: "value needs a number of 0 or more" },
    { line: 8, reason: "next_at isn't a date like 2026-11-19" },
    { line: 9, reason: "contact ct_gone is archived" },
    { line: 10, reason: "contact ct_gone is archived" },
    { line: 11, reason: "the email doesn't look like an email address" },
    { line: 12, reason: "no person matches and there's no name to add one" },
    { line: 13, reason: "no person matches and there's no name to add one" },
  ]);
  for (const { reason } of planned.skipped) assert.doesNotMatch(reason, /Secret|Imaginary|sideways|lots|tuesday|not-an-email|gail@/);
});

test("deals: a name shared by two people on file is not guessed", async () => {
  const db = await withPeople();
  db.exec(`INSERT INTO contacts (id, name, business, untrusted_fields) VALUES ('ct_twin1', 'Sam Twin', 'Twin Shop', '[]'), ('ct_twin2', 'Sam Twin', 'Twin Shop', '[]')`);
  const { plan: planned } = await plan(db, "title,name,business\r\nA sign,Sam Twin,Twin Shop\r\n");
  assert.deepEqual(planned.skipped, [{ line: 2, reason: "more than one person on file has this name and account (contact ct_twin1, ct_twin2)" }]);
});

test("deals: the export's fields column fills live deal fields (a field column wins), a merge only empty ones; archived rows never come in", async () => {
  const db = await withPeople();
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_budget', 'deal', 'budget', 'Budget', 'text'), ('fd_hours', 'deal', 'hours', 'Hours', 'number')`);
  db.exec(`UPDATE deals SET fields = '{"budget":"100"}' WHERE id = 'dl_onfile'`);
  const csv = [
    "id,title,contact_id,fields,Budget,archived",
    `dl_onfile,Boiler page,ct_pat,"{""budget"":""999"",""hours"":3}",,0`,
    `dl_new1,Sign,ct_pat,"{""budget"":""200"",""hours"":""2"",""secret"":""Secret""}",250,`,
    `dl_new2,Sign two,ct_pat,"""just text""",,`,
    `dl_new3,Old sign,ct_pat,{},,1`,
    `dl_onfile2,Boiler page,ct_pat,{},,true`,
  ].join("\r\n");
  const { ctx, plan: planned } = await plan(db, csv);
  assert.deepEqual(planned.merge, [{ id: "dl_onfile", line: 2, changes: {}, fields: { hours: 3 } }]);
  assert.deepEqual(planned.create.map((row) => [row.id, row.fields]), [["dl_new1", { budget: "250", hours: 2 }]]);
  assert.deepEqual(planned.skipped, [
    { line: 4, reason: "the fields column isn't valid" },
    { line: 5, reason: "archived in the file" },
    { line: 6, reason: "archived in the file" },
  ]);
  assert.deepEqual(planned.archived, [5, 6]);
  const input = dealsModule.change(planned, ctx, NOW);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const byId = new Map((await dealsOf(db)).map((deal) => [deal.id, deal]));
  assert.deepEqual(JSON.parse(byId.get("dl_onfile")?.fields ?? ""), { budget: "100", hours: 3 });
  assert.deepEqual(JSON.parse(byId.get("dl_new1")?.untrusted_fields ?? ""), ["title", "budget", "hours"]);
  assert.equal(byId.has("dl_new3"), false);
});
