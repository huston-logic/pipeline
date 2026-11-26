import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { approved, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { addLead } from "../services/leads.ts";
import { addTask } from "../services/tasks.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ROBIN_FORM = "This is a fake test message from Robin Sample";

async function emptyClient() {
  return connectInMemory(createMcpServer({ db: await openTestDb(), now: () => NOW }));
}

async function seededClient() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return connectInMemory(createMcpServer({ db, now: () => NOW }));
}

type Deal = { id: string; stageKey: string; status: string };

test("empty database: every read tool says there is nothing yet instead of failing", async () => {
  const c = await emptyClient();
  assert.match((await ok(c, "pipeline_summary")).headline, /^Your pipeline is empty/);
  assert.match((await ok(c, "list_deals")).headline, /^Your pipeline is empty/);
  assert.match((await ok(c, "list_deals", { status: "won" })).headline, /^No deals match those filters\.$/);
  assert.match((await ok(c, "search_contacts", { query: "" })).headline, /^There are no contacts yet/);
  assert.match((await ok(c, "search_contacts", { query: "pat" })).headline, /^No contacts match that search\.$/);
  assert.equal((await ok(c, "whats_due")).headline, "Nothing is due today (2026-11-19) and nothing is overdue.");
  assert.match((await ok(c, "recent_changes")).headline, /^No changes since Thu Nov 12, 10:00 AM\.$/);
  assert.match((await ok(c, "get_rulebook")).headline, /^Rulebook: 5 documents \(leads, capture, voice, pipeline, guardrails\)\.$/);
  assert.match(await fails(c, "get_deal", { deal: "Pat Example" }), /^No deal matches "Pat Example"\. Use list_deals/);
});

test("pipeline_summary counts open deals by stage and the closed ones", async () => {
  const answer = await ok(await seededClient(), "pipeline_summary");
  assert.equal(answer.headline, "6 open deals (total value 4650) across 5 open stages; 1 won, 1 lost, 0 not now.");
  const data = answer.data as { stages: { key: string; count: number }[] };
  assert.deepEqual(
    data.stages.map((s) => [s.key, s.count]),
    [["new_inquiry", 2], ["replied", 1], ["call_booked", 1], ["call_done", 1], ["proposal_sent", 1]],
  );
});

test("list_deals filters by stage, status, due and quiet", async () => {
  const c = await seededClient();
  const deals = async (args: Record<string, unknown>) => ((await ok(c, "list_deals", args)).data as { deals: Deal[] }).deals;
  assert.equal((await deals({})).length, 8);
  assert.deepEqual((await deals({ stage: "Call booked" })).map((d) => d.id), ["dl_seed01"]);
  assert.deepEqual((await deals({ status: "won" })).map((d) => d.id), ["dl_seed07"]);
  assert.deepEqual((await deals({ due: "week" })).map((d) => d.id).sort(), ["dl_seed01", "dl_seed04"]);
  assert.deepEqual((await deals({ quiet: 10 })).map((d) => d.id), ["dl_seed06"]);
  assert.equal((await ok(c, "list_deals", { stage: "replied" })).headline, "1 deal found.");
  assert.match(await fails(c, "list_deals", { stage: "Nope" }), /^There's no stage "Nope"\. Stages: New inquiry \(new_inquiry\)/);
  assert.match(await fails(c, "list_deals", { quiet: "a week" }), /"quiet" must be a whole number|"quiet" must be a number/);
  assert.match(await fails(c, "list_deals", { due: "tomorrow" }), /"due" must be one of: overdue, today, week/);
});

test("get_deal returns the brief with outside text labelled, and keeps it out of the headline", async () => {
  const answer = await ok(await seededClient(), "get_deal", { deal: "dl_seed02" });
  assert.equal(answer.headline, "Deal dl_seed02 is in New inquiry: 1 timeline entry, 0 open tasks, no next step yet.");
  assert.doesNotMatch(answer.headline, /Robin|Sample|fake test message/);
  const brief = answer.data as {
    contact: { name: string; untrusted_fields: string[] };
    timeline: { type: string; untrusted_text: string | null }[];
  };
  assert.deepEqual(brief.contact.untrusted_fields, ["name", "email", "business"]);
  assert.equal(brief.timeline[0]?.type, "form");
  assert.match(brief.timeline[0]?.untrusted_text ?? "", new RegExp(ROBIN_FORM));
  const text = JSON.stringify(brief);
  assert.equal(text.split(ROBIN_FORM).length, 2, "the outside text appears once, in untrusted_text");
});

test("get_deal finds a deal by its contact's name and refuses unknown or ambiguous names", async () => {
  const c = await seededClient();
  assert.match((await ok(c, "get_deal", { deal: "pat example" })).headline, /^Deal dl_seed01 is in Call booked: 4 timeline entries, 1 open task, a next step is set\.$/);
  assert.match(await fails(c, "get_deal", { deal: "Nobody" }), /^No deal matches "Nobody"/);
  assert.match(await fails(c, "get_deal", {}), /"deal" is missing; it needs text \(the deal: its id/);
});

test("search_contacts returns contacts with their deals and untrusted_fields", async () => {
  const answer = await ok(await seededClient(), "search_contacts", { query: "sample" });
  assert.equal(answer.headline, "2 contacts found.");
  const { contacts } = answer.data as { contacts: { id: string; untrusted_fields: string[]; deals: unknown[] }[] };
  assert.deepEqual(contacts.map((c) => c.id), ["ct_seed07", "ct_seed02"]);
  assert.deepEqual(contacts[1]?.untrusted_fields, ["name", "email", "business"]);
  assert.deepEqual(contacts[0]?.untrusted_fields, []);
  assert.equal(contacts[1]?.deals.length, 1);
});

test("whats_due counts overdue and today's tasks and deals in the owner's timezone", async () => {
  const answer = await ok(await seededClient(), "whats_due");
  assert.equal(
    answer.headline,
    "Due by the end of today (2026-11-19): 1 overdue task, 1 task due today, 0 overdue deals, 0 deals with a next step today.",
  );
  const due = answer.data as { overdueTasks: { id: string }[]; todayTasks: { id: string; description: string | null }[] };
  assert.deepEqual(due.overdueTasks.map((t) => t.id), ["tk_seed02"]);
  assert.deepEqual(due.todayTasks.map((t) => t.id), ["tk_seed01"]);
  assert.equal(due.todayTasks[0]?.description, null, "every task item carries its description (null for none)");
});

test("recent_changes takes an optional since date and explains a bad one", async () => {
  const c = await seededClient();
  await approved(c, "add_lead", { name: "Lee Example" });
  const week = await ok(c, "recent_changes");
  assert.equal(week.headline, "1 change since Thu Nov 12, 10:00 AM, newest first.");
  const later = await ok(c, "recent_changes", { since: "2026-11-20" });
  assert.equal(later.headline, "No changes since Fri Nov 20, 12:00 AM.");
  assert.equal((later.data as { since: string }).since, "2026-11-20T08:00:00.000Z");
  assert.match(await fails(c, "recent_changes", { since: "last week" }), /^"last week" isn't a date I can read\. Use YYYY-MM-DD/);
});

test("get_rulebook returns every document or one by name", async () => {
  const c = await emptyClient();
  const all = (await ok(c, "get_rulebook")).data as { documents: { name: string; markdown: string }[] };
  assert.deepEqual(all.documents.map((d) => d.name), ["leads", "capture", "voice", "pipeline", "guardrails"]);
  assert.ok(all.documents.every((d) => d.markdown.length > 0));
  assert.equal((await ok(c, "get_rulebook", { name: "voice" })).headline, "Rulebook: 1 document (voice).");
  assert.match(await fails(c, "get_rulebook", { name: "tone" }), /^There's no rulebook document "tone"\. Documents: leads, capture, voice, pipeline, guardrails\./);
});

async function leadsClient() {
  const db = await openTestDb();
  const ctx = { db, now: NOW, actor: "ai" as const, tool: "add_lead" };
  const ann = await addLead(ctx, { name: "Ann Example", source: "Trade fair" });
  const bo = await addLead(ctx, { name: "Bo Example" });
  const cy = await addLead(ctx, { name: "Cy Example" });
  await db.prepare("UPDATE contacts SET lead_status = 'contacted', person_status = 'lead', sub_status = 'contacted' WHERE id = ?").bind(bo.contactId).run();
  await db.prepare("UPDATE contacts SET lead_status = 'bad', person_status = 'lead', sub_status = 'bad' WHERE id = ?").bind(cy.contactId).run();
  await addTask({ db, now: NOW, actor: "ai", tool: "add_task" }, { contactId: ann.contactId, title: "Reach out", dueAt: "2026-11-19T15:00" });
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"name\"]' WHERE id = ?").bind(bo.contactId).run();
  await db.prepare("UPDATE contacts SET untrusted_fields = '[\"source\"]' WHERE id = ?").bind(ann.contactId).run();
  return { c: await connectInMemory(createMcpServer({ db, now: () => NOW })), ann, bo };
}

test("list_leads is a read tool, answers an empty database, and keeps names out of the headline", async () => {
  const { tools } = await (await emptyClient()).listTools();
  assert.equal(tools.find((t) => t.name === "list_leads")?.annotations?.readOnlyHint, true);
  assert.match(tools.find((t) => t.name === "list_leads")?.description ?? "", /who should I reach out to/);
  assert.equal((await ok(await emptyClient(), "list_leads")).headline, "No leads match.");

  const { c, ann, bo } = await leadsClient();
  const answer = await ok(c, "list_leads");
  assert.equal(answer.headline, "2 leads (1 new, 1 contacted).");
  assert.doesNotMatch(answer.headline, /Ann|Bo|Cy/);
  const data = answer.data as { total: number; items: { id: string; untrusted_fields: string[] }[]; sources: { key: string }[] };
  assert.deepEqual(data.items.map((i) => i.id), [ann.contactId, bo.contactId]);
  assert.deepEqual(data.items[1]?.untrusted_fields, ["name"]);
  assert.deepEqual(data.sources.map((s) => s.key), ["trade fair"]);
  assert.deepEqual((data.sources[0] as { untrusted_fields?: string[] }).untrusted_fields, ["label"], "an outside-only label is flagged");
  assert.deepEqual(data.items[0]?.untrusted_fields, ["source"]);

  assert.equal((await ok(c, "list_leads", { statuses: ["bad"] })).headline, "1 lead (1 bad lead).");
  assert.equal((await ok(c, "list_leads", { dueWithinDays: 0 })).headline, "1 lead (1 new).");
  assert.equal((await ok(c, "list_leads", { dueWithinDays: 3, sort: "added", source: "TRADE FAIR", query: "ann" })).headline, "1 lead (1 new).");
  assert.equal((await ok(c, "list_leads", { query: "nobody" })).headline, "No leads match.");
  assert.match(await fails(c, "list_leads", { statuses: ["won"] }), /statuses/);
  assert.match(await fails(c, "list_leads", { quietDays: 0 }), /quietDays/);
  assert.match(await fails(c, "list_leads", { sort: "random" }), /sort/);
});

test("search_contacts shows lead status and can filter by it; pipeline_summary adds a leads sentence only with leads", async () => {
  const { c, ann } = await leadsClient();
  const found = (await ok(c, "search_contacts", { query: "example" })).data as { contacts: { id: string; leadStatus: string | null }[] };
  assert.equal(found.contacts.length, 3);
  const filtered = (await ok(c, "search_contacts", { query: "example", leadStatus: ["new"] })).data as { contacts: { id: string }[] };
  assert.deepEqual(filtered.contacts.map((m) => m.id), [ann.contactId]);

  const summary = await ok(c, "pipeline_summary");
  assert.match(summary.headline, / Leads: 1 new, 1 contacted, 1 bad lead; 1 follow-up due this week\.$/);
  assert.equal((summary.data as { leads: { counts: { new: number } } }).leads.counts.new, 1);
  assert.doesNotMatch((await ok(await emptyClient(), "pipeline_summary")).headline, /Leads/);
});

test("read tools refuse unknown arguments by name", async () => {
  const message = await fails(await emptyClient(), "pipeline_summary", { verbose: true });
  assert.match(message, /^Fix the pipeline_summary request: Unknown field "verbose"\. This tool takes no arguments\.$/);
});

test("every deal, task, timeline and contact-deal item lists its outside values in untrusted_fields", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(`INSERT INTO tasks (id, deal_id, title, due_at, untrusted_fields)
    VALUES ('tk_outside', 'dl_seed02', 'Follow up with Robin Sample', '2026-11-19T19:00:00.000Z', '["title"]')`);
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW }));

  const { stages } = (await ok(c, "pipeline_summary")).data as { stages: { deals: (Deal & { untrusted_fields: string[] })[] }[] };
  const deals = new Map(stages.flatMap((s) => s.deals).map((d) => [d.id, d.untrusted_fields]));
  assert.deepEqual(deals.get("dl_seed02"), ["title", "contactName"]);
  assert.deepEqual(deals.get("dl_seed01"), []);
  assert.equal(deals.size, 6);
  assert.ok([...deals.values()].every(Array.isArray));

  const due = (await ok(c, "whats_due")).data as { todayTasks: { id: string; untrusted_fields: string[] }[] };
  const labels = new Map(due.todayTasks.map((t) => [t.id, t.untrusted_fields]));
  assert.deepEqual(labels.get("tk_outside"), ["title", "dealTitle", "contactName"]);
  assert.deepEqual(labels.get("tk_seed01"), []);

  const brief = (await ok(c, "get_deal", { deal: "dl_seed02" })).data as {
    deal: { untrusted_fields: string[] };
    timeline: { actor: string; untrusted_fields: string[] }[];
    openTasks: { untrusted_fields: string[] }[];
  };
  assert.deepEqual(brief.deal.untrusted_fields, ["title", "contactName"]);
  assert.deepEqual(brief.timeline[0]?.untrusted_fields, ["summary"], "the form activity was written by the system");
  assert.deepEqual(brief.openTasks[0]?.untrusted_fields, ["title", "dealTitle", "contactName"]);
  const pat = (await ok(c, "get_deal", { deal: "dl_seed01" })).data as { timeline: { untrusted_fields: string[] }[] };
  assert.ok(pat.timeline.every((item) => item.untrusted_fields.length === 0));

  const { contacts } = (await ok(c, "search_contacts", { query: "Robin" })).data as {
    contacts: { deals: { untrusted_fields: string[] }[] }[];
  };
  assert.deepEqual(contacts[0]?.deals[0]?.untrusted_fields, ["title"]);
});

test("list_tasks: undated standalone tasks, standalone filter, contact filter, done, limit, and outside titles (decision 0048)", async () => {
  const db = await createTestDb();
  const ctx = { db, now: NOW, actor: "ai" as const, tool: "add_task" };
  const ann = await addLead({ ...ctx, tool: "add_lead" }, { name: "Ann Example" });
  const bo = await addLead({ ...ctx, tool: "add_lead" }, { name: "Bo Example" });
  await addTask(ctx, { title: "Buy printer ink" });
  await addTask(ctx, { contactId: ann.contactId, title: "Call Ann", dueAt: "2026-11-18" });
  await addTask(ctx, { contactId: bo.contactId, title: "Email Bo", dueAt: "2026-11-25" });
  const done = await addTask(ctx, { title: "Old chore" });
  await db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").bind(NOW.toISOString(), done.taskId).run();
  await db.prepare("UPDATE tasks SET untrusted_fields = '[\"title\"]' WHERE title = 'Email Bo'").run();
  await db.prepare("UPDATE tasks SET description = 'Ask about the quote.', untrusted_fields = '[\"title\",\"description\"]' WHERE title = 'Email Bo'").run();
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW }));
  type Item = { id: string; title: string; dueAt: string | null; snoozedUntil: string | null; doneAt: string | null; dealId: string | null; contactId: string | null; untrusted_fields: string[] };

  const open = await ok(c, "list_tasks");
  const items = (open.data as { tasks: Item[] }).tasks;
  assert.deepEqual(items.map((t) => t.title), ["Call Ann", "Email Bo", "Buy printer ink"], "overdue first, undated last");
  assert.equal(open.headline, "3 open tasks.");
  assert.ok(!open.headline.includes("Bo"), "no title in the headline");
  assert.deepEqual(items[1]?.untrusted_fields, ["title", "description"]);
  assert.deepEqual(items.map((t) => (t as Item & { description: string | null }).description), [null, "Ask about the quote.", null]);
  assert.deepEqual([items[2]?.dueAt, items[2]?.dealId, items[2]?.contactId, items[2]?.doneAt], [null, null, null, null]);

  const alone = (await ok(c, "list_tasks", { standalone: true })).data as { tasks: Item[] };
  assert.deepEqual(alone.tasks.map((t) => t.title), ["Buy printer ink"]);
  const ofAnn = (await ok(c, "list_tasks", { contact: "Ann Example" })).data as { tasks: Item[] };
  assert.deepEqual(ofAnn.tasks.map((t) => t.title), ["Call Ann"]);
  const finished = await ok(c, "list_tasks", { status: "done" });
  assert.deepEqual((finished.data as { tasks: Item[] }).tasks.map((t) => t.title), ["Old chore"]);
  assert.equal(finished.headline, "1 done task.");
  assert.equal(((await ok(c, "list_tasks", { limit: 2 })).data as { tasks: Item[] }).tasks.length, 2);
  assert.match(await fails(c, "list_tasks", { contact: "Nobody Example" }), /^No contact matches "Nobody Example"/);
  assert.match(await fails(c, "list_tasks", { standalone: true, contact: ann.contactId }), /standalone/);
  assert.equal((await ok(await emptyClient(), "list_tasks")).headline, "No open tasks.");
});
