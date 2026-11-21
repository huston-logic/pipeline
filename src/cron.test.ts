import assert from "node:assert/strict";
import { test } from "node:test";
import { CRON_JOBS, runScheduled } from "./cron.ts";
import type { Db } from "./db/db.ts";
import { openTestDb } from "./db/sqlite-d1.ts";
import type { Env } from "./env.ts";
import type { Ctx } from "./services/change.ts";
import { updateDeal } from "./services/deals.ts";
import { addDeal } from "./services/add-deal.ts";
import { addRule } from "./services/rules.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const ctxFor = (db: Db, tool: string): Ctx => ({ db, now: NOW, actor: "ai", tool });
const envFor = (db: Db) => ({ DB: db }) as unknown as Env;

test("the hourly run fires the rules and logs only a fixed event name and counts", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
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
    { event: "cron_rules_done", rules: 1, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 },
    { event: "cron_brief_done", composed: 0, sent: 0, failed: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(lines), /Pat|Website/);
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

test("the brief runs after the rules, so tasks the rules just made are in it", () => {
  assert.deepEqual(CRON_JOBS.map(([name]) => name), ["rules", "brief"]);
});

test("the brief includes a task the rules created in the same run, and logs no text from it", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const db = await openTestDb();
  const lead = await addDeal(ctxFor(db, "add_deal"), { name: "Pat Example", dealTitle: "Website refresh" });
  await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { stage: "Proposal sent" });
  await addRule(ctxFor(db, "add_rule"), { type: "stage_followup", stage: "proposal_sent", days: 3 });
  await runScheduled(envFor(db), later(3));
  const brief = await db.prepare("SELECT text FROM briefs").first<{ text: string }>();
  assert.match(brief?.text ?? "", /Follow up with Pat Example about Website refresh/);
  assert.doesNotMatch(logged.mock.calls.map((call) => String(call.arguments[0])).join("\n"), /Pat|Website/);
});
