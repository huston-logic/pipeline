import assert from "node:assert/strict";
import { test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { firstStageOfKind, ownerTimezone, stageLabels, workTypeById } from "./lookup.ts";
import { fieldDefRows, liveWorkTypeRows, personStatusRows, ReadMemo, settingsRow, stageRows, subStatusRows } from "./memo.ts";
import { clientLabel } from "./person-status.ts";
import { PlanCollector } from "./plan.ts";
import { statusLabels } from "./status-labels.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(WORK_TYPES_SQL);
  db.exec("UPDATE stages SET archived = 1 WHERE key = 'lost'; UPDATE work_types SET archived = 1 WHERE id = 'wt_admin'");
  db.exec("INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_one', 'deal', 'budget', 'Budget', 'number'), ('fd_two', 'contact', 'size', 'Size', 'text')");
  return db;
}

/** Every memo reader, as plain values. */
async function readAll(src: Parameters<typeof settingsRow>[0]) {
  const labels = await statusLabels(src);
  return {
    settings: await settingsRow(src),
    timezone: await ownerTimezone(src),
    stages: await stageRows(src),
    allStages: await stageRows(src, { includeArchived: true }),
    open: await firstStageOfKind(src, "open"),
    stageLabels: [...(await stageLabels(src))],
    fields: await fieldDefRows(src),
    dealFields: await fieldDefRows(src, { entity: "deal", includeArchived: true }),
    statuses: await personStatusRows(src),
    subs: await subStatusRows(src),
    leadSubs: await subStatusRows(src, "lead"),
    labels: [labels.status("contact"), labels.both("contact", "client"), labels.lead("contacted")],
    client: await clientLabel(src),
    workTypes: await liveWorkTypeRows(src),
  };
}

test("with a memo every settings-like read answers as the database does, from one D1 call", async () => {
  const db = await setup();
  const plain = await readAll(db);
  const counted = countingDb(db);
  const memo = new ReadMemo(counted);
  const ctx = { db: counted, memo };
  assert.deepEqual(await readAll(ctx), plain);
  assert.deepEqual(await workTypeById(ctx, "wt_admin"), await workTypeById(db, "wt_admin"), "archived ones too");
  assert.equal(await workTypeById(ctx, "wt_none"), null);
  assert.equal(counted.calls, 1, counted.log.join("\n"));
  // A caller changing what it got doesn't change what the next one gets.
  (await settingsRow(ctx)).timezone = "Europe/Paris";
  assert.equal(await ownerTimezone(ctx), DEFAULT_TZ);
});

test("without a memo the readers go to the database every time", async () => {
  const db = await setup();
  const counted = countingDb(db);
  await ownerTimezone({ db: counted });
  await ownerTimezone({ db: counted });
  await ownerTimezone(counted);
  assert.equal(counted.calls, 3);
});

test("a plan can't write a table the memo holds while the memo is set", async () => {
  const db = await setup();
  const plan = new PlanCollector();
  const settings = (await settingsRow(db)) as unknown as Record<string, string | number | null>;
  const input = { target: { table: "settings" as const, id: "1" }, summary: "x", changes: [{ table: "settings" as const, id: "1", before: settings, after: { ...settings, timezone: "UTC" } }] };
  assert.throws(() => plan.record({ db, now: NOW, actor: "ai", tool: "x", plan, memo: new ReadMemo(db) }, input), /A plan can't change settings: the request memo holds it\./);
  assert.doesNotThrow(() => plan.record({ db, now: NOW, actor: "ai", tool: "x", plan }, input));
});
