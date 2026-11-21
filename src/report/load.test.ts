import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "../services/change.ts";
import { addDeal } from "../services/add-deal.ts";
import { logActivity } from "../services/activities.ts";
import { addLead } from "../services/leads.ts";
import { composeCaught } from "./caught.ts";
import { loadCaughtInput } from "./load.ts";

const TZ = "America/Los_Angeles";
const DAY = 86_400_000;
// Oct 10, 2026, 11 AM in Los Angeles.
const MADE = new Date("2026-10-10T18:00:00.000Z");
const ctxFor = (db: Db, now: Date, tool = "add_deal"): Ctx => ({ db, now, actor: "ai", tool });
const run = async (db: Db, sql: string, ...params: (string | number | null)[]) => db.prepare(sql).bind(...params).run();

async function addRuleRow(db: Db) {
  await run(db, `INSERT INTO rules (id, type, params, description, created_by) VALUES ('rl_a', 'gone_quiet', '{"type":"gone_quiet","days":5}', 'x', 'owner')`);
}

async function nudge(db: Db, n: number, target: { dealId?: string; contactId?: string }, firedAt: Date, doneAt: Date | null = null) {
  await run(
    db,
    `INSERT INTO tasks (id, deal_id, contact_id, title, source, done_at, created_at, updated_at) VALUES (?, ?, ?, 'Follow up', 'rl_a', ?, ?, ?)`,
    `tk_${n}`, target.dealId ?? null, target.contactId ?? null, doneAt?.toISOString() ?? null, firedAt.toISOString(), firedAt.toISOString(),
  );
  await run(
    db,
    `INSERT INTO rule_firings (id, rule_id, deal_id, contact_id, fire_key, task_id, fired_at) VALUES (?, 'rl_a', ?, ?, ?, ?, ?)`,
    `rf_${n}`, target.dealId ?? null, target.contactId ?? null, `key${n}`, `tk_${n}`, firedAt.toISOString(),
  );
}

/** Counts the statements the loader sends, so a test can check the number does not grow with the data. */
function counting(db: Db): { db: Db; count: () => number } {
  let n = 0;
  return {
    db: {
      prepare: (sql) => {
        n += 1;
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
    },
    count: () => n,
  };
}

test("loads a month's firings, their tasks, reaches, deals and leads, and the composed report is right", async () => {
  const db = await openTestDb();
  await addRuleRow(db);
  const one = await addDeal(ctxFor(db, MADE), { name: "Pat Example", dealTitle: "Website refresh", value: 1200 });
  const two = await addDeal(ctxFor(db, MADE), { name: "Robin Sample", dealTitle: "Menu", value: 300 });
  await nudge(db, 1, { dealId: one.dealId }, MADE);
  await nudge(db, 2, { dealId: two.dealId }, MADE);
  // A reach on deal one, two days after the nudge; a plain note on deal two, which is not a reach.
  await logActivity(ctxFor(db, new Date(MADE.getTime() + 2 * DAY), "log_activity"), { dealId: one.dealId, type: "call", summary: "Called" });
  await logActivity(ctxFor(db, new Date(MADE.getTime() + 2 * DAY), "log_activity"), { dealId: two.dealId, type: "note", summary: "Thought about it" });
  // Outside the month: a firing in September and one in November.
  await nudge(db, 3, { dealId: one.dealId }, new Date("2026-09-30T20:00:00.000Z"));
  await nudge(db, 4, { dealId: one.dealId }, new Date("2026-11-02T20:00:00.000Z"));

  const input = await loadCaughtInput(db, "2026-10", TZ);
  assert.equal(input.firings.length, 2);
  assert.deepEqual(input.firings.map((f) => f.taskId).sort(), ["tk_1", "tk_2"]);
  assert.equal(input.tasks.length, 2);
  assert.deepEqual(input.deals.map((d) => d.value).sort((a, b) => (a ?? 0) - (b ?? 0)), [300, 1200]);

  const report = composeCaught(input);
  assert.equal(report.rulesFired, 2);
  assert.equal(report.actedOn, 1);
  assert.equal(report.dealsTouched, 1);
  assert.equal(report.valueTouched, 1200);
});

test("a task completed later counts; a reach on an archived deal's nudge still counts (the deal is read by id)", async () => {
  const db = await openTestDb();
  await addRuleRow(db);
  const deal = await addDeal(ctxFor(db, MADE), { name: "Pat Example", dealTitle: "Website refresh", value: 700 });
  await nudge(db, 1, { dealId: deal.dealId }, MADE, new Date(MADE.getTime() + 20 * DAY));
  await run(db, "UPDATE deals SET archived = 1 WHERE id = ?", deal.dealId);
  const report = composeCaught(await loadCaughtInput(db, "2026-10", TZ));
  assert.equal(report.actedOn, 1);
  assert.equal(report.valueTouched, 700);
});

test("leads: created in the month, first reach in the month, qualified in the month; people who were never leads are left out", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, MADE, "add_lead"), { name: "Lead One", source: "Referral" });
  const older = await addLead(ctxFor(db, MADE, "add_lead"), { name: "Lead Two", source: "referral " });
  const never = await addDeal(ctxFor(db, MADE), { name: "Deal Person", dealTitle: "Deal" });
  await run(db, "UPDATE contacts SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?", older.contactId);
  // Lead One: first reach on Oct 12, later reach on Oct 15; Lead Two: reached in September and again in October.
  const log = (id: string, iso: string, type: "call" | "note" = "call") =>
    logActivity(ctxFor(db, new Date(iso), "log_activity"), { contactId: id, type, summary: "x", occurredAt: iso });
  await log(lead.contactId, "2026-10-12T18:00:00.000Z");
  await log(lead.contactId, "2026-10-15T18:00:00.000Z");
  await log(older.contactId, "2026-09-02T18:00:00.000Z");
  await log(older.contactId, "2026-10-20T18:00:00.000Z");
  await run(db, "UPDATE contacts SET lead_status = 'qualified', lead_status_at = '2026-10-25T18:00:00.000Z' WHERE id = ?", lead.contactId);
  await log(never.contactId, "2026-10-12T18:00:00.000Z");

  const input = await loadCaughtInput(db, "2026-10", TZ);
  assert.deepEqual(input.leads.map((l) => l.id).sort(), [lead.contactId].sort());
  const report = composeCaught(input);
  assert.deepEqual(report.bySource, [{ source: "Referral", outside: false, added: 1, contacted: 1, qualified: 1 }]);
});

test("a plain note is not a reach; a text note is", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, MADE, "add_lead"), { name: "Lead One", source: "Fair" });
  const later = ctxFor(db, new Date("2026-10-20T18:00:00.000Z"), "log_activity");
  await logActivity(later, { contactId: lead.contactId, type: "note", summary: "A thought", occurredAt: "2026-10-12T18:00:00.000Z" });
  assert.equal(composeCaught(await loadCaughtInput(db, "2026-10", TZ)).bySource[0]?.contacted, 0);
  await logActivity(later, { contactId: lead.contactId, type: "note", summary: "Texted", via: "text", occurredAt: "2026-10-13T18:00:00.000Z" });
  assert.equal(composeCaught(await loadCaughtInput(db, "2026-10", TZ)).bySource[0]?.contacted, 1);
});

test("a source set from outside is marked so", async () => {
  const db = await openTestDb();
  const lead = await addLead(ctxFor(db, MADE, "add_lead"), { name: "Lead One", source: "Web form" });
  await run(db, `UPDATE contacts SET untrusted_fields = '["source"]' WHERE id = ?`, lead.contactId);
  const [row] = composeCaught(await loadCaughtInput(db, "2026-10", TZ)).bySource;
  assert.equal(row?.outside, true);
});

test("the number of statements is fixed, however much data the month holds", async () => {
  const db = await openTestDb();
  await addRuleRow(db);
  const first = counting(db);
  await loadCaughtInput(first.db, "2026-10", TZ);
  for (let n = 1; n <= 12; n += 1) {
    const deal = await addDeal(ctxFor(db, MADE), { name: `Person ${n}`, dealTitle: `Deal ${n}`, value: n });
    await nudge(db, n, { dealId: deal.dealId }, MADE);
    await addLead(ctxFor(db, MADE, "add_lead"), { name: `Lead ${n}`, source: `Source ${n}` });
  }
  const second = counting(db);
  await loadCaughtInput(second.db, "2026-10", TZ);
  assert.equal(second.count(), first.count());
  assert.ok(first.count() <= 5, `at most 5 statements (got ${first.count()})`);
});
