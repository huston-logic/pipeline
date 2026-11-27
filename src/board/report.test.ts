import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { addMonths, lastMonth, monthBounds, monthLabel } from "../report/month.ts";
import { runBrief } from "../brief/run.ts";
import { latestBrief } from "../services/read.ts";
import { DEFAULT_TZ } from "../time.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const DAY = 86_400_000;

function envFor(db: SqliteD1): Env {
  return { ENVIRONMENT: "development", AUTH_MODE: "dev", DB: db, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
}

async function get(db: SqliteD1, path: string) {
  const res = await worker.fetch(new Request(`http://localhost:4821${path}`), envFor(db), ctx);
  return { res, body: await res.text() };
}

const mainOf = (body: string) => /<main id="main" tabindex="-1"[^>]*>([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const LAST = () => lastMonth(new Date(), DEFAULT_TZ);

/** One rule, one deal, one nudge made 3 days into the month and completed, and two leads from sources. */
function seedMonth(db: SqliteD1, month: string) {
  const day = (n: number) => new Date(monthBounds(month, DEFAULT_TZ).start.getTime() + n * DAY).toISOString();
  db.exec(`
    INSERT INTO contacts (id, name, created_at, updated_at) VALUES ('ct_rep001', 'Pat Example', '${day(0)}', '${day(0)}');
    INSERT INTO deals (id, contact_id, title, stage_key, value, stage_entered_at, created_at, updated_at)
      VALUES ('dl_rep001', 'ct_rep001', 'Website refresh', 'new_inquiry', 4200, '${day(0)}', '${day(0)}', '${day(0)}');
    INSERT INTO rules (id, type, params, description, created_by) VALUES ('rl_rep001', 'gone_quiet', '{"type":"gone_quiet","days":5}', 'x', 'owner');
    INSERT INTO tasks (id, deal_id, title, source, done_at, created_at, updated_at)
      VALUES ('tk_rep001', 'dl_rep001', 'Follow up', 'rl_rep001', '${day(4)}', '${day(3)}', '${day(4)}');
    INSERT INTO rule_firings (id, rule_id, deal_id, fire_key, task_id, fired_at) VALUES ('rf_rep001', 'rl_rep001', 'dl_rep001', 'k', 'tk_rep001', '${day(3)}');
    INSERT INTO contacts (id, name, source, lead_status, lead_status_at, created_at, updated_at)
      VALUES ('ct_rep002', 'Lead One', 'Referral', 'qualified', '${day(10)}', '${day(1)}', '${day(1)}');
    INSERT INTO contacts (id, name, source, untrusted_fields, lead_status, lead_status_at, created_at, updated_at, person_status, sub_status)
      VALUES ('ct_rep003', 'Lead Two', '<b>Web form</b>', '["source"]', 'new', '${day(2)}', '${day(2)}', '${day(2)}', 'lead', 'new');
    INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_rep001', 'ct_rep002', 'call', 'Called', '${day(5)}', 'owner');
  `);
}

test("an empty month says so, with the month's name, and links back but not forward", async () => {
  const db = await createTestDb();
  const { res, body } = await get(db, "/report");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(body, /<title>What it caught · Pipeline<\/title>/);
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  const main = mainOf(body);
  assert.match(main, /<h1>What it caught<\/h1>/);
  assert.ok(main.includes(`Nothing to report for ${monthLabel(LAST())}.`));
  assert.ok(main.includes(`href="/report?month=${addMonths(LAST(), -1)}"`), "Previous month");
  assert.doesNotMatch(main, /Next month/);
});

test("with the fixture seed the page answers 200", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(new Date(), DEFAULT_TZ));
  assert.equal((await get(db, "/report")).res.status, 200);
});

test("a month with activity shows the counts, the leads by source, and labels a source from outside", async () => {
  const db = await createTestDb();
  seedMonth(db, LAST());
  const { body } = await get(db, "/report");
  const main = mainOf(body);
  assert.ok(main.includes(`For ${monthLabel(LAST())}`));
  assert.match(main, /<dt>Rules fired<\/dt>\s*<dd>1<\/dd>/);
  assert.match(main, /<dt>Tasks made<\/dt>\s*<dd>1<\/dd>/);
  assert.match(main, /<dt>Acted on within 7 days<\/dt>\s*<dd>1 of 1<\/dd>/);
  assert.match(main, /<dt>Deals touched after a nudge<\/dt>\s*<dd>1, worth 4,200<\/dd>/);
  assert.match(main, /<h2[^>]*>Leads by source<\/h2>/);
  assert.match(main, /Referral[\s\S]*?1 added, 1 contacted, 1 qualified/);
  assert.match(main, /<span class="outside">From outside<\/span> <span class="outside-value">&lt;b&gt;Web form&lt;\/b&gt;<\/span>/);
  assert.doesNotMatch(main, /<b>Web form/);
  assert.doesNotMatch(main, /Nothing to report/);
});

test("?month picks a finished month within 12 months; anything else is the default, and nothing typed is echoed", async () => {
  const db = await createTestDb();
  const three = addMonths(LAST(), -2);
  assert.ok(mainOf((await get(db, `/report?month=${three}`)).body).includes(`Nothing to report for ${monthLabel(three)}.`));
  const oldest = addMonths(LAST(), -11);
  assert.ok(mainOf((await get(db, `/report?month=${oldest}`)).body).includes(`for ${monthLabel(oldest)}.`));
  assert.doesNotMatch(mainOf((await get(db, `/report?month=${oldest}`)).body), /Previous month/);
  for (const bad of [addMonths(LAST(), -12), addMonths(LAST(), 1), "2026-13", "<script>alert(1)</script>", "", "x"]) {
    const { res, body } = await get(db, `/report?month=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200, bad);
    assert.ok(mainOf(body).includes(`for ${monthLabel(LAST())}.`), bad);
    assert.ok(!body.includes("<script>alert"), bad);
  }
});

test("Previous and Next month links carry only a month, and Next appears once there is a later finished month", async () => {
  const db = await createTestDb();
  const middle = addMonths(LAST(), -3);
  const main = mainOf((await get(db, `/report?month=${middle}`)).body);
  assert.ok(main.includes(`href="/report?month=${addMonths(middle, -1)}"`));
  assert.ok(main.includes(`href="/report?month=${addMonths(middle, 1)}"`));
  const hrefs = [...main.matchAll(/href="(\/report[^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) assert.match(href ?? "", /^\/report\?month=\d{4}-\d{2}$/);
});

test("a brief composed on the 1st reads back with its Last month section, in latestBrief and on the Brief page", async () => {
  const db = await createTestDb();
  seedMonth(db, "2026-11");
  db.exec("UPDATE settings SET brief = 1");
  const first = new Date("2026-12-01T15:00:00.000Z"); // 7 AM on Dec 1 in Los Angeles
  assert.deepEqual(await runBrief({ DB: db } as unknown as Env, first), { composed: 1, sent: 0, failed: 0 });

  const stored = await latestBrief(db);
  const lastMonthItems = (stored?.items ?? []).filter((item) => item.section === "last_month");
  assert.ok(lastMonthItems.length >= 6, "four count lines and two sources");
  assert.equal(lastMonthItems.filter((item) => item.untrusted).length, 1, "only the outside source line");

  const { body } = await get(db, "/brief");
  const main = mainOf(body);
  assert.match(main, /<h2 id="brief-last_month">Last month<\/h2>/);
  assert.match(main, /Rules fired: 1/);
  assert.match(main, /Acted on within 7 days: 1 of 1/);
  assert.match(main, /Leads from Referral: 1 added, 1 contacted, 1 qualified/);
  assert.match(main, /<span class="outside">From outside<\/span> <span class="outside-value">Leads from &lt;b&gt;Web form&lt;\/b&gt;: 1 added/);
});

test("the report is behind the same sign-in as the other pages", async () => {
  const db = await createTestDb();
  const res = await worker.fetch(new Request("http://localhost:4821/report"), { ...envFor(db), AUTH_MODE: undefined }, ctx);
  assert.notEqual(res.status, 200);
});
