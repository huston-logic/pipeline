import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createTestDb, type SqliteD1 } from "../src/db/sqlite-d1.ts";
import type { Db } from "../src/db/db.ts";
import { MAX_FIRINGS_PER_RUN, type PreviewRequest, previewRuleFor, runRules } from "../src/services/rules.ts";
import { buildScaleSeed, DUE_FIRINGS, parseScaleArgs, SCALE, scaleSeed } from "./seed-scale.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const CONTACT_TYPES = "('form', 'email', 'call', 'meeting', 'note')";

let db: SqliteD1;
before(async () => {
  db = await createTestDb();
  db.exec(buildScaleSeed(NOW));
});

const count = async (sql: string) => (await db.prepare(sql).first<number>("n")) ?? 0;

test("the scale seed has the sizes the CPU check names, with clean foreign keys", async () => {
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal(await count("SELECT COUNT(*) AS n FROM deals"), SCALE.deals);
  assert.equal(await count("SELECT COUNT(*) AS n FROM contacts"), SCALE.contacts);
  assert.equal(await count("SELECT COUNT(*) AS n FROM activities"), SCALE.activities);
  assert.equal(await count("SELECT COUNT(*) AS n FROM tasks"), SCALE.tasks);
  assert.equal(await count("SELECT COUNT(*) AS n FROM briefs"), SCALE.briefs);
  assert.equal(await count("SELECT COUNT(DISTINCT business) AS n FROM contacts"), SCALE.companies);
  assert.equal(await count("SELECT COUNT(*) AS n FROM rules"), 5);
  assert.ok((await count("SELECT COUNT(*) AS n FROM rule_firings")) > 0);
  assert.ok((await count("SELECT COUNT(*) AS n FROM audit_log")) > SCALE.deals);
  assert.equal(await count("SELECT COUNT(*) AS n FROM deals WHERE status = 'open'"), 1_200);
});

test("every address is a fake one", async () => {
  assert.equal(
    await count(
      "SELECT COUNT(*) AS n FROM contacts WHERE email NOT LIKE '%@example.com' AND email NOT LIKE '%@example.org' AND email NOT LIKE '%@example.net'",
    ),
    0,
  );
});

test("deal dates follow from the activities, the way the services keep them", async () => {
  // last_activity_at is the newest contact entry; stage_entered_at is the newest stage move, or creation.
  assert.equal(
    await count(
      `SELECT COUNT(*) AS n FROM deals d WHERE d.last_activity_at IS NOT (SELECT MAX(occurred_at) FROM activities a
         WHERE a.deal_id = d.id AND a.type IN ${CONTACT_TYPES})`,
    ),
    0,
  );
  assert.equal(
    await count(
      `SELECT COUNT(*) AS n FROM deals d WHERE d.stage_entered_at IS NOT
         COALESCE((SELECT MAX(occurred_at) FROM activities a WHERE a.deal_id = d.id AND a.type = 'stage_change'), d.created_at)`,
    ),
    0,
  );
  assert.equal(await count(`SELECT COUNT(*) AS n FROM activities WHERE occurred_at > '${NOW.toISOString()}'`), 0);
});

test("the next hourly run has 50 firings due: it writes MAX_FIRINGS_PER_RUN and defers the rest", async () => {
  const due = DUE_FIRINGS.replied + DUE_FIRINGS.proposalSent;
  assert.equal(due, 50);
  const local = await createTestDb();
  local.exec(buildScaleSeed(NOW));
  const first = await runRules(local, NOW);
  assert.deepEqual(first, { rules: 4, fired: MAX_FIRINGS_PER_RUN, alreadyFired: 0, failed: 0, deferred: due - MAX_FIRINGS_PER_RUN });
  const second = await runRules(local, new Date(NOW.getTime() + 3_600_000));
  assert.equal(second.fired, due - MAX_FIRINGS_PER_RUN);
  assert.equal(second.deferred, 0);
});

test("preview_rule on the Replied follow-up finds deals on the scaled copy", async () => {
  const preview = await previewRuleFor(db, NOW, { rule: "ru_scale02" });
  assert.ok(preview.dealCount >= DUE_FIRINGS.replied, `found ${preview.dealCount}`);
});

/** The same database, but the preview's activity read gets every activity, whatever lookback it binds. */
function readEverything(db: Db): Db {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/FROM activities\s+WHERE type IN/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, name, receiver) {
          if (name === "bind") return (...values: unknown[]) => target.bind(...values.slice(0, -1), "");
          const value: unknown = Reflect.get(target, name, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch: (statements) => db.batch(statements),
  };
}

test("on the scaled copy, preview_rule's shorter lookback gives exactly the hits a read of every activity gives", async () => {
  const settings: PreviewRequest[] = [
    { rule: "ru_scale01" },
    { rule: "ru_scale02" },
    { rule: "ru_scale03" },
    { rule: "ru_scale04" },
    { rule: "ru_scale05" },
    { type: "stage_followup", stage: "Call booked", days: 1 },
    { type: "stage_followup", stage: "Proposal sent", days: 60 },
    { type: "gone_quiet", days: 3 },
    { type: "gone_quiet", days: 45 },
    { type: "on_stage_enter", stage: "Call done", title: "Send notes", dueInDays: 0 },
  ];
  for (const request of settings) {
    const short = await previewRuleFor(db, NOW, request);
    const full = await previewRuleFor(readEverything(db), NOW, request);
    assert.ok(full.hits.length > 0, `${JSON.stringify(request)} catches something`);
    assert.deepEqual(short.hits, full.hits, JSON.stringify(request));
  }
});

test("the same moment gives the same seed", () => {
  assert.equal(buildScaleSeed(NOW), buildScaleSeed(NOW));
  assert.equal(scaleSeed(NOW).deals[0]?.id, "dl_scale00000");
});

test("parseScaleArgs needs --out and refuses anything else", () => {
  assert.deepEqual(parseScaleArgs(["--out", "x.sql"]), { out: "x.sql" });
  assert.throws(() => parseScaleArgs([]), /--out/);
  assert.throws(() => parseScaleArgs(["--tz", "UTC"]), /Unknown option/);
});
