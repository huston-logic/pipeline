import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_CRON, CAMPAIGN_JOBS, CRON_JOBS, runScheduled } from "./cron.ts";
import type { Db } from "./db/db.ts";
import { openTestDb } from "./db/sqlite-d1.ts";
import type { Env } from "./env.ts";
import type { Ctx } from "./services/change.ts";
import { updateDeal } from "./services/deals.ts";
import { addDeal } from "./services/add-deal.ts";
import { addRule } from "./services/rules.ts";
import { createDraft, getDraft } from "./import/drafts.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const ctxFor = (db: Db, tool: string): Ctx => ({ db, now: NOW, actor: "ai", tool });
const envFor = (db: Db) => ({ DB: db }) as unknown as Env;

test("the hourly run fires the rules and logs only a fixed event name and counts", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET brief = 1").run();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "Proposal sent" });
  await addRule(ctxFor(db, "add_rule"), { type: "stage_followup", stage: "proposal_sent", days: 3 });

  await runScheduled(envFor(db), later(3));
  await runScheduled(envFor(db), later(3.05));
  const tasks = await db.prepare("SELECT title FROM tasks").all<{ title: string }>();
  assert.equal(tasks.results.length, 1);

  const lines = logged.mock.calls.map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>);
  assert.deepEqual(lines, [
    { event: "cron_rules_done", rules: 1, fired: 1, alreadyFired: 0, failed: 0, deferred: 0 },
    { event: "cron_brief_done", composed: 1, sent: 0, failed: 0 },
    { event: "cron_import_drafts_done", deleted: 0 },
    { event: "cron_proposals_done", deleted: 0 },
    { event: "cron_rules_done", rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 },
    { event: "cron_brief_done", composed: 0, sent: 0, failed: 0 },
    { event: "cron_import_drafts_done", deleted: 0 },
    { event: "cron_proposals_done", deleted: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(lines), /Pat|Website/);
});

test("with the brief off the follow-up rules still fire, and no brief is stored, emailed or pushed; on, it is stored", async (t) => {
  t.mock.method(console, "log", () => {});
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const db = await openTestDb();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "Proposal sent" });
  await addRule(ctxFor(db, "add_rule"), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  const ready = { DB: db, BRIEF_SENDING: "on", RESEND_API_KEY: "re_fake_key", BRIEF_FROM: "brief@example.test" } as unknown as Env;
  const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n;
  assert.equal(await count("SELECT COUNT(*) AS n FROM settings WHERE brief = 0"), 1, "off by default");

  await runScheduled(ready, later(3));
  assert.equal(await count("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Follow up with%'"), 1, "the rule fired");
  assert.equal(await count("SELECT COUNT(*) AS n FROM rule_firings"), 1, "its firing is recorded");
  assert.equal(await count("SELECT COUNT(*) AS n FROM briefs"), 0, "no brief stored");
  assert.equal(fetched.mock.callCount(), 0, "no email or push attempted");

  await db.prepare("UPDATE settings SET brief = 1").run();
  await runScheduled(ready, later(3.05));
  assert.equal(await count("SELECT COUNT(*) AS n FROM briefs"), 1, "on: the brief is stored");
});

test("a failing job logs a fixed failure event without details, and the other jobs still run", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const ran: string[] = [];
  await runScheduled(envFor(await openTestDb()), NOW, [
    ["first", async () => { throw new Error("D1_ERROR: pat@example.com"); }],
    ["second", async () => { ran.push("second"); return { done: 1 }; }],
  ]);
  assert.deepEqual(ran, ["second"]);
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [JSON.stringify({ event: "cron_first_failed" })]);
});

test("the brief runs after the rules, so tasks the rules just made are in it; expired drafts and proposals go last", () => {
  assert.deepEqual(CRON_JOBS.map(([name]) => name), ["rules", "brief", "import_drafts", "proposals"]);
});

test("the campaign cron has its own schedule and one job", () => {
  assert.equal(CAMPAIGN_CRON, "5,20,35,50 * * * *");
  assert.deepEqual(CAMPAIGN_JOBS.map(([name]) => name), ["campaigns"]);
});

test("the hourly run deletes expired proposals and logs only the count (decision 0044)", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
  const insert = "INSERT INTO proposals (id, actions, reads, text, status, created_at, expires_at) VALUES (?, '[]', '{}', 'List', ?, ?, ?)";
  const at = (days: number) => later(days).toISOString();
  await db.batch([
    db.prepare(insert).bind("pr_old", "open", at(-1), at(-0.9)),
    db.prepare(insert).bind("pr_fresh", "open", at(0), at(0.08)),
    db.prepare(insert).bind("pr_done", "applied", at(-0.5), at(-0.4)),
    db.prepare(insert).bind("pr_gone", "dropped", at(-1.1), at(-1)),
  ]);
  const [, job] = CRON_JOBS.find(([name]) => name === "proposals") ?? [];
  assert.ok(job);
  assert.deepEqual(await job(envFor(db), NOW), { deleted: 2 });
  const left = await db.prepare("SELECT id FROM proposals ORDER BY id").all<{ id: string }>();
  assert.deepEqual(left.results.map((row) => row.id), ["pr_done", "pr_fresh"]);
  assert.equal(logged.mock.callCount(), 0);
});

test("the hourly run deletes expired import drafts and logs only the count (decision 0036)", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
  const old = await createDraft(db, { module: "people", text: "name\r\nPat Example\r\n", mapping: [], asLeads: false, now: later(-1) });
  const fresh = await createDraft(db, { module: "people", text: "name\r\nRobin Sample\r\n", mapping: [], asLeads: false, now: NOW });
  const [, job] = CRON_JOBS.find(([name]) => name === "import_drafts") ?? [];
  assert.ok(job);
  assert.deepEqual(await job(envFor(db), NOW), { deleted: 1 });
  assert.equal(await getDraft(db, old, NOW), null);
  assert.ok(await getDraft(db, fresh, NOW));
  assert.doesNotMatch(JSON.stringify(logged.mock.calls), /Pat|Robin/);
});

test("the brief includes a task the rules created in the same run, and logs no text from it", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
  await db.prepare("UPDATE settings SET brief = 1").run();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "Proposal sent" });
  await addRule(ctxFor(db, "add_rule"), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  await runScheduled(envFor(db), later(3));
  const brief = await db.prepare("SELECT text FROM briefs").first<{ text: string }>();
  assert.match(brief?.text ?? "", /Follow up with Pat Example about Website refresh/);
  assert.doesNotMatch(logged.mock.calls.map((call) => String(call.arguments[0])).join("\n"), /Pat|Website/);
});
