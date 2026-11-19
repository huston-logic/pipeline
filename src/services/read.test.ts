import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevSeed } from "../../scripts/seed-dev.ts";
import type { Db } from "../db/db.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addLead } from "./leads.ts";
import { getDealBrief, listDealsFiltered, pipelineSummary, recentChanges, searchContacts, whatsDue } from "./read.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const TZ = DEFAULT_TZ;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  db.exec(buildDevSeed(NOW, TZ));
  return db;
}

test("every read answers an empty database with empty lists and zero counts", async () => {
  const db = await openTestDb();
  const summary = await pipelineSummary(db, NOW, TZ);
  assert.deepEqual(
    summary.stages.map((s) => [s.key, s.count, s.value, s.deals.length]),
    [
      ["new_inquiry", 0, 0, 0],
      ["replied", 0, 0, 0],
      ["call_booked", 0, 0, 0],
      ["call_done", 0, 0, 0],
      ["proposal_sent", 0, 0, 0],
    ],
  );
  assert.deepEqual(summary.closed, { won: 0, lost: 0, not_now: 0 });
  assert.deepEqual(summary.open, { count: 0, value: 0 });
  assert.equal(summary.total, 0);

  assert.deepEqual(await whatsDue(db, NOW, TZ), {
    today: "2026-11-19",
    overdueTasks: [],
    todayTasks: [],
    overdueDeals: [],
    todayDeals: [],
  });
  assert.deepEqual(await searchContacts(db, "pat"), []);
  assert.deepEqual(await searchContacts(db, ""), []);
  assert.deepEqual(await listDealsFiltered(db, {}, NOW, TZ), []);
  assert.deepEqual(await listDealsFiltered(db, { due: "week", quiet: 3 }, NOW, TZ), []);
  assert.deepEqual(await recentChanges(db, new Date(0)), []);
  await assert.rejects(getDealBrief(db, "dl_nothing", TZ, NOW), UserError);
});

test("pipelineSummary counts and lists the open deals per stage, plus closed counts", async () => {
  const db = await seededDb();
  const summary = await pipelineSummary(db, NOW, TZ);
  assert.deepEqual(
    summary.stages.map((s) => [s.key, s.label, s.count, s.value, ids(s.deals)]),
    [
      ["new_inquiry", "New inquiry", 2, 0, ["dl_seed06", "dl_seed02"]],
      ["replied", "Replied", 1, 0, ["dl_seed03"]],
      ["call_booked", "Call booked", 1, 1500, ["dl_seed01"]],
      ["call_done", "Call done", 1, 2400, ["dl_seed04"]],
      ["proposal_sent", "Proposal sent", 1, 750, ["dl_seed05"]],
    ],
  );
  assert.deepEqual(summary.closed, { won: 1, lost: 1, not_now: 0 });
  assert.deepEqual(summary.open, { count: 6, value: 4650 });
  assert.equal(summary.total, 8);

  const pat = summary.stages[2]?.deals[0];
  assert.ok(pat);
  assert.equal(pat.title, "Website refresh for Example Plumbing");
  assert.equal(pat.contactName, "Pat Example");
  assert.equal(pat.nextStep, "Discovery call");
  assert.equal(pat.nextAt, "2026-11-21T22:00:00.000Z");
  assert.equal(pat.nextAtLocal, "Sat Nov 21, 2:00 PM");
  assert.equal(pat.overdue, false);
});

test("whatsDue splits overdue and today in the owner's timezone and skips done and snoozed tasks", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET next_at = '2026-11-18T20:00:00.000Z' WHERE id = 'dl_seed03'").run();
  await db.prepare("UPDATE deals SET next_at = '2026-11-20T07:59:00.000Z' WHERE id = 'dl_seed02'").run();
  await db.prepare("UPDATE deals SET next_at = '2026-11-18T20:00:00.000Z' WHERE id = 'dl_seed07'").run();

  const due = await whatsDue(db, NOW, TZ);
  assert.equal(due.today, "2026-11-19");
  assert.deepEqual(ids(due.overdueTasks), ["tk_seed02"]);
  assert.deepEqual(ids(due.todayTasks), ["tk_seed01"]);
  assert.deepEqual(ids(due.overdueDeals), ["dl_seed03"], "won deals are not due");
  assert.deepEqual(ids(due.todayDeals), ["dl_seed02"], "11:59 PM local is still today");

  const task = due.overdueTasks[0];
  assert.equal(task?.title, "Send Casey the price sheet");
  assert.equal(task?.dealTitle, "Landscaping site with a quote form");
  assert.equal(task?.contactName, "Casey Placeholder");
  assert.equal(task?.dueAtLocal, "Wed Nov 18, 9:00 AM");
});

test("getDealBrief has the contact with untrusted_fields, the timeline newest first with untrusted_text, and open tasks", async () => {
  const db = await seededDb();
  const robin = await getDealBrief(db, "dl_seed02", TZ, NOW);
  assert.equal(robin.contact.name, "Robin Sample");
  assert.deepEqual(robin.contact.untrusted_fields, ["name", "email", "business"]);
  assert.equal(robin.stage.label, "New inquiry");
  const [form] = robin.timeline;
  assert.equal(form?.type, "form");
  assert.match(form?.untrusted_text ?? "", /fake test message/);

  const pat = await getDealBrief(db, "website refresh for example plumbing", TZ, NOW);
  assert.equal(pat.deal.id, "dl_seed01");
  assert.deepEqual(ids(pat.timeline), ["ac_seed04", "ac_seed03", "ac_seed02", "ac_seed01"]);
  assert.deepEqual(pat.timeline[0]?.data, { from: "replied", to: "call_booked" });
  assert.equal(pat.timeline[1]?.untrusted_text, null);
  assert.deepEqual(ids(pat.openTasks), ["tk_seed01"]);
  assert.deepEqual(pat.next, { step: "Discovery call", at: "2026-11-21T22:00:00.000Z", atLocal: "Sat Nov 21, 2:00 PM" });
  assert.deepEqual(pat.contact.untrusted_fields, []);

  const morgan = await getDealBrief(db, "dl_seed06", TZ, NOW);
  assert.deepEqual(ids(morgan.openTasks), ["tk_seed05"], "the contact's own tasks are included");
});

test("searchContacts matches name, email or business and lists each contact's deals", async () => {
  const db = await seededDb();
  const found = await searchContacts(db, "bakery");
  assert.deepEqual(ids(found), ["ct_seed02"]);
  assert.deepEqual(found[0]?.deals, [
    {
      id: "dl_seed02",
      title: "New website for Sample Bakery",
      stageLabel: "New inquiry",
      status: "open",
      untrusted_fields: ["title"],
    },
  ]);
  assert.deepEqual(ids(await searchContacts(db, "SAMPLE")), ["ct_seed07", "ct_seed02"]);
  assert.deepEqual(ids(await searchContacts(db, "jordan@example")), ["ct_seed04"]);
});

test("listDealsFiltered filters by stage, status, due window and quiet days", async () => {
  const db = await seededDb();
  assert.equal((await listDealsFiltered(db, {}, NOW, TZ)).length, 8);
  assert.deepEqual(ids(await listDealsFiltered(db, { stage: "call booked" }, NOW, TZ)), ["dl_seed01"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { status: "won" }, NOW, TZ)), ["dl_seed07"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "week" }, NOW, TZ)), ["dl_seed01", "dl_seed04"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "today" }, NOW, TZ)), []);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "overdue" }, NOW, TZ)), []);
  assert.deepEqual(ids(await listDealsFiltered(db, { quiet: 5 }, NOW, TZ)), ["dl_seed06", "dl_seed05"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { quiet: 5, status: "won" }, NOW, TZ)), ["dl_seed07"]);
  const [item] = await listDealsFiltered(db, { stage: "call_done" }, NOW, TZ);
  assert.equal(item?.contactName, "Jordan Fake");
  assert.equal(item?.stageLabel, "Call done");
  assert.equal(item?.value, 2400);
  await assert.rejects(listDealsFiltered(db, { stage: "nowhere" }, NOW, TZ), /There's no stage "nowhere"/);
  await assert.rejects(listDealsFiltered(db, { quiet: 0 }, NOW, TZ), /whole number of days/);
});

test("recentChanges lists changes newest first with who, what and whether they were undone", async () => {
  const db = await openTestDb();
  const at = (iso: string, tool: string): Ctx => ({ db, now: new Date(iso), actor: "ai", tool });
  const lead = await addLead(at("2026-11-19T16:00:00.000Z", "add_lead"), { name: "Pat Example", dealTitle: "Site" });
  const move = await updateDeal(at("2026-11-19T17:00:00.000Z", "update_deal"), lead.dealId, { stage: "replied" });
  const undo = await undoChange(at("2026-11-19T17:30:00.000Z", "undo_change"), move.changeId);

  const changes = await recentChanges(db, new Date("2026-11-19T16:30:00.000Z"));
  assert.deepEqual(
    changes.map((c) => [c.changeId, c.tool, c.undone]),
    [
      [undo.changeId, "undo_change", false],
      [move.changeId, "update_deal", true],
    ],
  );
  assert.equal(changes[0]?.undoOf, move.changeId);
  assert.equal(changes[1]?.undoneBy, undo.changeId);
  assert.equal(changes[1]?.summary, move.summary);
  assert.equal(changes[1]?.actor, "ai");
  assert.equal(changes[1]?.at, "2026-11-19T17:00:00.000Z");
  assert.equal((await recentChanges(db, new Date(0))).length, 3);
});
