// The services recognize a stale write (write_guard's CHECK), a foreign-key failure and a duplicate rule fire key by
// the database's error text.
// Unit tests use node:sqlite; this checks the same detection against real local D1 (workerd, via wrangler's
// getPlatformProxy) on a fresh temp database, so the owner gets the plain UserError messages in production too.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getPlatformProxy } from "wrangler";
import type { DealRow } from "../../src/db/db.ts";
import { getDeal } from "../../src/db/queries.ts";
import {
  commitChange,
  type Ctx,
  isFireKeyFailure,
  isForeignKeyFailure,
  isGuardFailure,
  StaleWriteError,
  updatedRow,
} from "../../src/services/change.ts";
import { UserError } from "../../src/services/errors.ts";
import { prepareState, ROOT } from "./harness.ts";

let stateDir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;

before(async () => {
  stateDir = prepareState("pipeline-d1-");
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(ROOT, "wrangler.jsonc"),
    // wrangler's --persist-to <dir> keeps its data in <dir>/v3.
    persist: { path: join(stateDir, "v3") },
    envFiles: [],
    remoteBindings: false,
  });
});

after(async () => {
  await proxy?.dispose();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

const ctx = (): Ctx => ({ db: proxy.env.DB, now: new Date(), actor: "ai", tool: "d1_errors_test" });

async function seededDeal(): Promise<DealRow> {
  const deal = await getDeal(proxy.env.DB, "dl_seed01");
  assert.ok(deal, "the fake seed is loaded");
  return deal;
}

test("a stale write on real D1 becomes the plain StaleWriteError and changes nothing", async () => {
  const stale = await seededDeal();
  await commitChange(ctx(), {
    target: { table: "deals", id: stale.id },
    summary: "First edit",
    changes: [{ table: "deals", id: stale.id, before: stale, after: updatedRow(stale, { next_step: "First" }, new Date()) }],
  });
  await assert.rejects(
    commitChange(ctx(), {
      target: { table: "deals", id: stale.id },
      summary: "Second edit from a stale read",
      changes: [{ table: "deals", id: stale.id, before: stale, after: updatedRow(stale, { next_step: "Second" }, new Date()) }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StaleWriteError);
      assert.equal((error as Error).message, "Deal dl_seed01 changed since you read it. Read it again and retry.");
      assert.ok(isGuardFailure((error as Error).cause), "D1's own error is recognized as a guard failure");
      return true;
    },
  );
  assert.equal((await seededDeal()).next_step, "First");
});

test("a foreign-key failure on real D1 is recognized", async () => {
  const now = new Date().toISOString();
  const orphan: DealRow = {
    ...(await seededDeal()),
    id: "dl_orphan00000",
    contact_id: "ct_missing0000",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  await assert.rejects(
    commitChange(ctx(), {
      target: { table: "deals", id: orphan.id },
      summary: "Deal for a contact that does not exist",
      changes: [{ table: "deals", id: orphan.id, before: null, after: orphan }],
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof UserError), "a raw database error is not shown to the owner");
      assert.ok(isForeignKeyFailure(error), `recognized: ${String(error)}`);
      return true;
    },
  );
  assert.equal(await getDeal(proxy.env.DB, orphan.id), null);
});

test("a duplicate rule fire key on real D1 is recognized, and the losing batch writes nothing", async () => {
  const db = proxy.env.DB;
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO rules (id, type, params, description, created_by) VALUES (?, 'gone_quiet', ?, 'Test rule', 'owner')")
    .bind("ru_d1test00000", JSON.stringify({ type: "gone_quiet", days: 5 }))
    .run();
  const firing = (id: string) =>
    db
      .prepare("INSERT INTO rule_firings (id, rule_id, deal_id, fire_key, fired_at) VALUES (?, 'ru_d1test00000', 'dl_seed01', ?, ?)")
      .bind(id, "ru_d1test00000:dl_seed01:x", now);
  await firing("rf_first000000").run();
  const task = {
    id: "tk_d1test00000",
    deal_id: "dl_seed01",
    contact_id: "ct_seed01",
    title: "From a racing rule run",
    due_at: now,
    done_at: null,
    snoozed_until: null,
    source: "ru_d1test00000",
    untrusted_fields: "[]",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  await assert.rejects(
    commitChange({ ...ctx(), actor: "system", tool: "rules" }, {
      target: { table: "tasks", id: task.id },
      summary: "A second firing for the same stage entry",
      changes: [{ table: "tasks", id: task.id, before: null, after: task }],
      extra: [firing("rf_second00000")],
    }),
    (error: unknown) => {
      assert.ok(isFireKeyFailure(error), `recognized: ${String(error)}`);
      return true;
    },
  );
  assert.equal(await db.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first(), null);
});
