// The person status invariant (decision 0040): person_status is "lead" exactly when lead_status is an unqualified
// status, and then sub_status equals lead_status. Every service that moves or creates a person, and the undo of each,
// is run on the fixture seed, and the whole contacts table is checked after every step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeMessage, LOG_ADDRESS, OWNER, rawEmail } from "../../tests/helpers/fake-email.ts";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import type { Db } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { handleLogEmail } from "../email/log.ts";
import type { Env } from "../env.ts";
import { handleIntake } from "../http/intake.ts";
import { mapCsv, type ModuleShape, planRows } from "../import/engine.ts";
import { contactsOnFile, dealsOnFile, tasksOnFile } from "../import/load.ts";
import { dealsModule, peopleModule, tasksModule } from "../import/modules/index.ts";
import { DEFAULT_TZ } from "../time.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import { type ChangeInput, type ChangeResult, commitChange, type Ctx } from "./change.ts";
import { updateContact } from "./contacts.ts";
import { updateDeal } from "./deals.ts";
import { addLead, qualifyLead, returnToLead } from "./leads.ts";
import { UNQUALIFIED_STATUSES } from "./lead-status.ts";
import { setPersonStatus, statusEntries } from "./person-status.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const SECRET = "test-intake-secret";
const ctxFor = (db: Db, tool: string): Ctx => ({ db, now: NOW, actor: "owner", tool });

const keys = UNQUALIFIED_STATUSES.map((status) => `'${status}'`).join(", ");

/** Every contact that breaks the invariant, with its four columns. */
async function broken(db: Db): Promise<unknown[]> {
  const found = await db
    .prepare(
      `SELECT id, person_status, sub_status, lead_status FROM contacts
       WHERE (person_status = 'lead') <> (COALESCE(lead_status, '') IN (${keys}))
          OR (person_status = 'lead' AND sub_status IS NOT lead_status)`,
    )
    .all();
  return found.results.map((row) => ({ ...row }));
}

async function seeded() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  // Three leads on top of the fixture: New, Contacted and Not a fit (with a lost deal, so a reopen qualifies them).
  const fresh = await addLead(ctxFor(db, "add_lead"), { name: "Nell New", email: "nell@example.com" });
  const reached = await addLead(ctxFor(db, "add_lead"), { name: "Cora Contacted", email: "cora@example.org" });
  await updateContact(ctxFor(db, "update_contact"), reached.contactId, { leadStatus: "contacted" });
  const unfit = await addDeal(ctxFor(db, "add_deal"), { name: "Finn Unfit", email: "finn@example.net", dealTitle: "Sign" });
  await updateDeal(ctxFor(db, "update_deal"), unfit.dealId, { status: "lost" });
  await updateContact(ctxFor(db, "update_contact"), unfit.contactId, { leadStatus: "not_a_fit" });
  return { db, newId: fresh.contactId, contactedId: reached.contactId, unfitDeal: unfit.dealId };
}

async function latestChange(db: Db, tool: string): Promise<string> {
  const id = await db.prepare("SELECT id FROM audit_log WHERE tool = ? ORDER BY rowid DESC LIMIT 1").bind(tool).first<string>("id");
  assert.ok(id, `a ${tool} change`);
  return id;
}

async function importFile<C, P extends { skipped: unknown[] }>(
  db: Db,
  module: ModuleShape & { plan(rows: never, ctx: C, options: never): P; change(plan: P, ctx: C, now: Date): ChangeInput | null },
  csv: string,
  load: (rows: ReturnType<typeof mapCsv>["rows"]) => Promise<C>,
  options: object,
): Promise<ChangeResult> {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const { rows } = mapCsv(module, csv, fieldDefs);
  const ctx = await load(rows);
  const plan = planRows(module as never, rows, ctx as never, { fieldDefs, ...options } as never) as P;
  assert.deepEqual(plan.skipped, []);
  const input = module.change(plan, ctx, NOW);
  assert.ok(input);
  return commitChange({ db, now: NOW, actor: "owner", tool: "import" }, input);
}

test("every write that moves or creates a person, and its undo, keeps person_status and lead_status in step", async () => {
  const { db, newId, contactedId, unfitDeal } = await seeded();
  assert.deepEqual(await broken(db), [], "the fixture seed");
  const env = {
    ENVIRONMENT: "development",
    DB: db,
    ASSETS: { fetch: async () => new Response("nope", { status: 404 }) },
    INTAKE_SECRET: SECRET,
    INTAKE_RATE_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as Env;

  const steps: [string, () => Promise<string>][] = [
    ["add_lead", async () => (await addLead(ctxFor(db, "add_lead"), { name: "Lou Lead", business: "Lou's Shop" })).changeId],
    ["add_deal for a lead", async () => (await addDeal(ctxFor(db, "add_deal"), { contact: newId, dealTitle: "Roof" })).changeId],
    ["add_deal for someone new", async () => (await addDeal(ctxFor(db, "add_deal"), { name: "Dee Deal", email: "dee@example.com" })).changeId],
    [
      "intake from a lead",
      async () => {
        const request = new Request("http://localhost:4821/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Intake-Secret": SECRET },
          body: JSON.stringify({ name: "Cora Contacted", email: "cora@example.org", message: "A quote, please." }),
        });
        assert.equal((await handleIntake(request, env, NOW)).status, 201);
        return latestChange(db, "intake");
      },
    ],
    ["qualify_lead", async () => (await qualifyLead(ctxFor(db, "qualify_lead"), { contact: contactedId })).changeId],
    ["qualify_lead with no deal", async () => (await qualifyLead(ctxFor(db, "qualify_lead"), { contact: newId, createDeal: false })).changeId],
    ["return_to_lead", async () => (await returnToLead(ctxFor(db, "return_to_lead"), { deal: "dl_seed03", status: "bad" })).changeId],
    ["update_contact to Not now", async () => (await updateContact(ctxFor(db, "update_contact"), newId, { leadStatus: "not_now" })).changeId],
    ["update_contact gives a contact a lead status", async () => (await updateContact(ctxFor(db, "update_contact"), "ct_seed08", { leadStatus: "new" })).changeId],
    ["log_activity reaches a New lead", async () => (await logActivity(ctxFor(db, "log_activity"), { contactId: newId, type: "call", summary: "Called." })).changeId],
    [
      "email log reaches a New lead",
      async () => {
        const mail = rawEmail({ to: "Nell New <nell@example.com>", messageId: "<invariant@mail.example.com>" });
        const outcome = await handleLogEmail(fakeMessage(mail), { DB: db, EMAIL_LOG_ADDRESS: LOG_ADDRESS, OWNER_EMAILS: OWNER }, NOW);
        assert.equal(outcome, "logged");
        return latestChange(db, "email_log");
      },
    ],
    ["update_deal Won makes a Client", async () => (await updateDeal(ctxFor(db, "update_deal"), "dl_seed01", { stage: "won" })).changeId],
    ["update_deal marks a Not a fit lead's lost deal Won", async () => (await updateDeal(ctxFor(db, "update_deal"), unfitDeal, { status: "won" })).changeId],
    ["update_deal reopens a Not a fit lead's lost deal", async () => (await updateDeal(ctxFor(db, "update_deal"), unfitDeal, { stage: "replied" })).changeId],
    ["set_person_status to Partner", async () => (await setPersonStatus(ctxFor(db, "set_person_status"), contactedId, { status: "partner" })).changeId],
    ["set_person_status to Lead", async () => (await setPersonStatus(ctxFor(db, "set_person_status"), "ct_seed08", { status: "lead", sub: "contacted" })).changeId],
    [
      "import people",
      async () => {
        const csv = [
          "name,email,person_status,sub_status,lead_status",
          "Ann One,ann@example.com,lead,contacted,",
          "Ben Two,ben@example.com,partner,,",
          "Cy Three,cy@example.com,,,not_now",
          "Di Four,di@example.com,,,qualified",
          "Ed Five,ed@example.com,contact,client,new",
        ].join("\r\n");
        const statuses = await statusEntries(db);
        return (await importFile(db, peopleModule, csv, () => contactsOnFile(db), { asLeads: false, allowDuplicates: false, statuses })).changeId;
      },
    ],
    [
      "import deals for a lead and someone new",
      async () => {
        const csv = "title,email,name\r\nGarage,nell@example.com,Nell New\r\nPorch,gus@example.com,Gus New\r\n";
        return (await importFile(db, dealsModule, csv, (rows) => dealsOnFile(db, rows), { closedAsHistory: false })).changeId;
      },
    ],
    [
      "import tasks",
      async () => {
        const csv = "title,contact_id\r\nCall back,ct_seed01\r\n";
        return (await importFile(db, tasksModule, csv, (rows) => tasksOnFile(db, rows), {})).changeId;
      },
    ],
  ];

  for (const [name, step] of steps) {
    const changeId = await step();
    assert.deepEqual(await broken(db), [], `after ${name}`);
    await undoChange(ctxFor(db, "undo_change"), changeId);
    assert.deepEqual(await broken(db), [], `after undoing ${name}`);
  }
});

test("test databases refuse a row whose person status and lead status disagree, from a service or from raw SQL", async () => {
  const db = await createTestDb();
  assert.throws(
    () => db.exec("INSERT INTO contacts (id, name, lead_status) VALUES ('ct_bad', 'Bad Row', 'new')"),
    /person_status and lead_status disagree/,
  );
  assert.throws(
    () => db.exec("INSERT INTO contacts (id, name, lead_status, person_status, sub_status) VALUES ('ct_bad', 'Bad Row', 'new', 'lead', 'contacted')"),
    /disagree/,
  );
  assert.throws(() => db.exec("INSERT INTO contacts (id, name, person_status) VALUES ('ct_bad', 'Bad Row', 'lead')"), /disagree/);
  db.exec("INSERT INTO contacts (id, name, lead_status, person_status, sub_status) VALUES ('ct_ok', 'Ok Row', 'new', 'lead', 'new')");
  assert.throws(() => db.exec("UPDATE contacts SET lead_status = 'qualified' WHERE id = 'ct_ok'"), /disagree/);
  db.exec("INSERT INTO contacts (id, name, lead_status, person_status) VALUES ('ct_was', 'Was Lead', 'qualified', 'partner')");
});
