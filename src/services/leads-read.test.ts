import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import { logActivity } from "./activities.ts";
import { addDeal } from "./add-deal.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { addLead } from "./leads.ts";
import { leadCounts, listLeads } from "./leads-read.ts";
import type { LeadStatus } from "./lead-status.ts";
import { pipelineSummary, searchContacts } from "./read.ts";
import { addTask, snoozeTask } from "./tasks.ts";

// Thu Nov 19, 2026, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");
const TZ = "America/Los_Angeles";
const ctxFor = (db: Db, now = NOW, tool = "add_lead"): Ctx => ({ db, now, actor: "owner", tool });
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const day = (date: string) => new Date(`${date}T20:00:00.000Z`);

async function lead(
  db: Db,
  name: string,
  status: LeadStatus,
  created: string,
  extra: { business?: string; source?: string; email?: string; phone?: string } = {},
): Promise<string> {
  const { contactId } = await addLead(ctxFor(db, day(created)), { name, allowDuplicate: true, ...extra });
  await db.prepare("UPDATE contacts SET lead_status = ? WHERE id = ?").bind(status, contactId).run();
  return contactId;
}

async function reach(db: Db, contactId: string, type: "call" | "note", date: string, via?: "text"): Promise<void> {
  await logActivity(ctxFor(db, day(date), "log_activity"), { contactId, type, summary: "Logged", occurredAt: `${date}T12:00`, via });
}

async function task(db: Db, contactId: string, dueAt: string, title = "Check back"): Promise<string> {
  return (await addTask(ctxFor(db, NOW, "add_task"), { contactId, title, dueAt })).taskId;
}

/** The fixed set most tests read. */
async function seeded() {
  const db = await openTestDb();
  const a = await lead(db, "Ann Example", "new", "2026-11-01", { business: "Review Focus", source: "Trade Fair", email: "ann@example.com" });
  const b = await lead(db, "Bo Example", "contacted", "2026-11-02", { business: "review  focus", source: "trade fair", phone: "555-0102" });
  const c = await lead(db, "Cy Example", "not_now", "2026-11-03", { business: "Other Shop" });
  const d = await lead(db, "Di Example", "not_a_fit", "2026-11-04");
  const e = await lead(db, "Ed Example", "bad", "2026-11-05");
  const f = await lead(db, "Flo Example", "qualified", "2026-11-06");
  const g = await lead(db, "Gus Example", "new", "2026-11-07");
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = ?").bind(g).run();
  await addDeal(ctxFor(db, day("2026-11-08"), "add_deal"), { name: "Hal Example", dealTitle: "Site" });
  await reach(db, a, "call", "2026-11-10");
  await reach(db, b, "note", "2026-11-15", "text");
  await reach(db, b, "note", "2026-11-18");
  await db.prepare("UPDATE contacts SET lead_status = 'new' WHERE id = ?").bind(a).run();
  await task(db, a, "2026-11-25T09:00");
  await task(db, b, "2026-11-18T09:00");
  return { db, a, b, c, d, e, f, g };
}

test("an empty database answers with nothing", async () => {
  const db = await openTestDb();
  assert.deepEqual(await listLeads(db, NOW, TZ), { total: 0, items: [], sources: [] });
  assert.deepEqual(await leadCounts(db), { new: 0, contacted: 0, not_now: 0, not_a_fit: 0, bad: 0, qualified: 0 });
});

test("by default only New, Contacted and Not now are listed, soonest task first and none last", async () => {
  const { db, a, b, c } = await seeded();
  const list = await listLeads(db, NOW, TZ);
  assert.deepEqual(ids(list.items), [b, a, c]);
  assert.equal(list.total, 3);
  const [first] = list.items;
  assert.equal(first?.leadStatus, "contacted");
  assert.equal(first?.leadStatusLabel, "Contacted");
  assert.equal(first?.nextTaskAt, "2026-11-18T17:00:00.000Z");
  assert.equal(list.items[2]?.nextTaskAt, null);
});

test("statuses can ask for the closed-out and qualified ones, and an empty list means the default", async () => {
  const { db, d, e, f } = await seeded();
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { statuses: ["not_a_fit", "bad"] })).items), [d, e]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { statuses: ["qualified"] })).items), [f]);
  assert.equal((await listLeads(db, NOW, TZ, { statuses: [] })).total, 3);
});

test("source matches ignoring case and spacing, and the source groups ignore the source filter", async () => {
  const { db, a, b } = await seeded();
  const list = await listLeads(db, NOW, TZ, { source: "  TRADE   fair " });
  assert.deepEqual(ids(list.items).sort(), [a, b].sort());
  assert.deepEqual(list.sources, [{ key: "trade fair", label: "Trade Fair", count: 2, outside: false }]);
});

test("a source group is labelled with its earliest trusted spelling, and outside-only ones are marked", async () => {
  const { db, a, b } = await seeded();
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"source\"]' WHERE id = ?").bind(a).run();
  assert.deepEqual((await listLeads(db, NOW, TZ)).sources, [{ key: "trade fair", label: "trade fair", count: 2, outside: false }]);
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"source\"]' WHERE id = ?").bind(b).run();
  assert.deepEqual((await listLeads(db, NOW, TZ)).sources, [{ key: "trade fair", label: "Trade Fair", count: 2, outside: true }]);
});

test("lastContactAt counts calls and texts, ignores a plain note, and reaches through an archived deal", async () => {
  const { db, a, b, c } = await seeded();
  const items = new Map((await listLeads(db, NOW, TZ)).items.map((item) => [item.id, item]));
  assert.equal(items.get(a)?.lastContactAt, "2026-11-10T20:00:00.000Z");
  assert.equal(items.get(b)?.lastContactAt, "2026-11-15T20:00:00.000Z");
  assert.equal(items.get(c)?.lastContactAt, null);

  const deal = await addDeal(ctxFor(db, day("2026-11-12"), "add_deal"), { name: "Ida Example", dealTitle: "Menu" });
  await logActivity(ctxFor(db, day("2026-11-12"), "log_activity"), { dealId: deal.dealId, type: "call", summary: "Called", occurredAt: "2026-11-12T12:00" });
  await db.prepare("UPDATE deals SET archived = 1 WHERE id = ?").bind(deal.dealId).run();
  await db.prepare("UPDATE contacts SET lead_status = 'contacted' WHERE id = ?").bind(deal.contactId).run();
  const ida = (await listLeads(db, NOW, TZ)).items.find((item) => item.id === deal.contactId);
  assert.equal(ida?.lastContactAt, "2026-11-12T20:00:00.000Z");
});

test("quietDays measures from the latest reach, or from when the lead was added when there is none", async () => {
  const { db, a, c } = await seeded();
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { quietDays: 5 })).items), [a, c]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { quietDays: 10 })).items), [c]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { quietDays: 30 })).items), []);
});

test("dueWithinDays counts awake open tasks due before the end of the local day N days ahead, overdue included", async () => {
  const { db, a, b, c } = await seeded();
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { dueWithinDays: 0 })).items), [b]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { dueWithinDays: 5 })).items), [b], "Nov 25 9 AM is after the end of Nov 24");
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { dueWithinDays: 6 })).items), [b, a]);
  const snoozed = await task(db, c, "2026-11-19T09:00", "Snoozed");
  await snoozeTask(ctxFor(db, NOW, "snooze_task"), snoozed, "2026-11-30T09:00");
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { dueWithinDays: 0 })).items), [b], "a snoozed task is not due");
  const done = await task(db, c, "2026-11-19T08:00", "Done");
  await db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").bind(NOW.toISOString(), done).run();
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { dueWithinDays: 0 })).items), [b], "a done task is not due");
});

test("a task on one of the lead's deals counts as theirs", async () => {
  const { db, c } = await seeded();
  const deal = await addDeal(ctxFor(db, day("2026-11-12"), "add_deal"), { name: "Ida Example", dealTitle: "Menu" });
  await db.prepare("UPDATE contacts SET lead_status = 'new' WHERE id = ?").bind(deal.contactId).run();
  await addTask(ctxFor(db, NOW, "add_task"), { dealId: deal.dealId, title: "Call", dueAt: "2026-11-19T15:00" });
  await db.prepare("UPDATE tasks SET contact_id = NULL WHERE title = 'Call'").run();
  const list = await listLeads(db, NOW, TZ, { dueWithinDays: 0 });
  assert.ok(ids(list.items).includes(deal.contactId));
  assert.ok(!ids(list.items).includes(c));
});

test("the sort orders: next task, last contact (oldest first) and added (newest first), none last", async () => {
  const { db, a, b, c } = await seeded();
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { sort: "next_task" })).items), [b, a, c]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { sort: "last_contact" })).items), [a, b, c]);
  assert.deepEqual(ids((await listLeads(db, NOW, TZ, { sort: "added" })).items), [c, b, a]);
});

test("query searches name, email, phone and business, treating % and _ literally", async () => {
  const { db, a, b, c } = await seeded();
  const hits = async (query: string) => ids((await listLeads(db, NOW, TZ, { query })).items);
  assert.deepEqual(await hits("ann"), [a]);
  assert.deepEqual(await hits("ANN@example"), [a]);
  assert.deepEqual(await hits("555-0102"), [b]);
  assert.deepEqual(await hits("other shop"), [c]);
  assert.deepEqual(await hits("%"), []);
  assert.deepEqual(await hits("_"), []);
  assert.equal((await listLeads(db, NOW, TZ, { query: "  " })).total, 3);
});

test("at most 200 are listed and the total says how many match", async () => {
  const db = await openTestDb();
  for (let i = 0; i < 203; i++) await addLead(ctxFor(db, new Date(NOW.getTime() - i * 1000)), { name: `Lead ${i} Example` });
  const all = await listLeads(db, NOW, TZ);
  assert.equal(all.items.length, 200);
  assert.equal(all.total, 203);
  assert.equal((await listLeads(db, NOW, TZ, { limit: 5000 })).items.length, 200);
  assert.equal((await listLeads(db, NOW, TZ, { limit: 3 })).items.length, 3);
});

test("values from outside are listed in untrusted_fields", async () => {
  const { db, a } = await seeded();
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"email\",\"name\",\"source\"]' WHERE id = ?").bind(a).run();
  const item = (await listLeads(db, NOW, TZ)).items.find((it) => it.id === a);
  assert.deepEqual(item?.untrusted_fields, ["name", "source", "email"]);
});

test("bad filter numbers are refused in plain English", async () => {
  const db = await openTestDb();
  await assert.rejects(listLeads(db, NOW, TZ, { quietDays: 0 }), UserError);
  await assert.rejects(listLeads(db, NOW, TZ, { dueWithinDays: -1 }), UserError);
  await assert.rejects(listLeads(db, NOW, TZ, { quietDays: 1.5 }), UserError);
});

test("leadCounts counts each status and leaves out archived people and never-leads", async () => {
  const { db } = await seeded();
  assert.deepEqual(await leadCounts(db), { new: 1, contacted: 1, not_now: 1, not_a_fit: 1, bad: 1, qualified: 1 });
});

test("pipelineSummary has a leads line only when an unclosed lead exists (invariant 4)", async () => {
  const db = await openTestDb();
  assert.equal((await pipelineSummary(db, NOW, TZ)).leads, null);
  await lead(db, "Di Example", "not_a_fit", "2026-11-04");
  await lead(db, "Fay Example", "qualified", "2026-11-05");
  assert.equal((await pipelineSummary(db, NOW, TZ)).leads, null, "closed-out and qualified alone add no line");
  const { db: full, b } = await seeded();
  const leads = (await pipelineSummary(full, NOW, TZ)).leads;
  assert.deepEqual(leads?.counts, { new: 1, contacted: 1, not_now: 1, not_a_fit: 1, bad: 1, qualified: 1 });
  assert.equal(leads?.followUpsDueThisWeek, 2, "Nov 18 (overdue) and Nov 25 are both before the end of Nov 25");
  await full.prepare("UPDATE tasks SET done_at = ? WHERE contact_id = ?").bind(NOW.toISOString(), b).run();
  assert.equal((await pipelineSummary(full, NOW, TZ)).leads?.followUpsDueThisWeek, 1);
});

test("searchContacts shows each match's lead status, null for a never-lead, and can filter by status", async () => {
  const { db, a, b } = await seeded();
  const found = await searchContacts(db, "example");
  const byName = new Map(found.map((m) => [m.name, m]));
  assert.equal(byName.get("Ann Example")?.leadStatus, "new");
  assert.equal(byName.get("Ann Example")?.leadStatusLabel, "New");
  assert.equal(byName.get("Hal Example")?.leadStatus, null);
  assert.equal(byName.get("Hal Example")?.leadStatusLabel, null);
  assert.deepEqual(ids(await searchContacts(db, "example", { leadStatuses: ["new", "contacted"] })), [a, b]);
});
