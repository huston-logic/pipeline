import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb } from "../db/sqlite-d1.ts";
import { commitChange, type Ctx, type Row } from "./change.ts";
import { PlanCollector } from "./plan.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

const deal = (version: number, patch: Row = {}): Row => ({ id: "dl_a", title: "Example site", version, ...patch });

async function planCtx(): Promise<Ctx & { plan: PlanCollector }> {
  return { db: await openTestDb(), now: NOW, actor: "ai", tool: "propose_changes", plan: new PlanCollector() };
}

test("in collect mode commitChange records the change and writes nothing", async () => {
  const ctx = await planCtx();
  const target = { table: "deals", id: "dl_a" } as const;
  const result = await commitChange(ctx, { target, summary: "Moved  the deal", changes: [{ table: "deals", id: "dl_a", before: deal(3), after: deal(4, { stage_key: "won" }) }] });
  assert.deepEqual(result, { changeId: ctx.plan.changeId, summary: `Moved the deal (change ${ctx.plan.changeId})` });
  assert.match(ctx.plan.changeId, /^chg_[a-z2-7]{12}$/);
  assert.equal((await ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<number>("n")), 0);
  assert.deepEqual(ctx.plan.row("deals", "dl_a"), deal(4, { stage_key: "won" }));
  assert.equal(ctx.plan.row("deals", "dl_b"), undefined);
  assert.deepEqual(ctx.plan.summaries(), ["Moved the deal"]);
});

test("a row planned twice keeps its first before and its latest after, one version bump", async () => {
  const ctx = await planCtx();
  const target = { table: "deals", id: "dl_a" } as const;
  await commitChange(ctx, { target, summary: "One", changes: [{ table: "deals", id: "dl_a", before: deal(3), after: deal(4, { stage_key: "won" }) }] });
  const planned = ctx.plan.row("deals", "dl_a") as Row;
  await commitChange(ctx, { target, summary: "Two", changes: [{ table: "deals", id: "dl_a", before: planned, after: { ...planned, version: 5, value: 10 } }] });
  const added = { id: "ac_a", summary: "Call", version: 1 };
  await commitChange(ctx, { target: { table: "activities", id: "ac_a" }, summary: "Three", changes: [{ table: "activities", id: "ac_a", before: null, after: added }] });
  await commitChange(ctx, {
    target,
    summary: "Four",
    changes: [{ table: "activities", id: "ac_a", before: added, after: { ...added, version: 2, summary: "Call back" } }],
  });

  assert.deepEqual(ctx.plan.rows("deals", (row) => row.value === 10), [deal(4, { stage_key: "won", value: 10 })]);
  assert.deepEqual(ctx.plan.reads(), { "deals:dl_a": 3, "activities:ac_a": null });
  const built = ctx.plan.build(target, "All of it");
  assert.deepEqual(built.changes, [
    { table: "deals", id: "dl_a", before: deal(3), after: deal(4, { stage_key: "won", value: 10 }) },
    { table: "activities", id: "ac_a", before: null, after: { id: "ac_a", summary: "Call back", version: 1 } },
  ]);
  assert.deepEqual([built.target, built.summary], [target, "All of it"]);
  assert.deepEqual(ctx.plan.summaries(), ["One", "Two", "Three", "Four"]);
  assert.deepEqual(ctx.plan.target(), target);
});

test("extra statements keep the action they came from", async () => {
  const ctx = await planCtx();
  const target = { table: "deals", id: "dl_a" } as const;
  const guard = (n: number) => ctx.db.prepare("INSERT INTO write_guard (ok) VALUES (?)").bind(n);
  ctx.plan.startAction(1);
  await commitChange(ctx, { target, summary: "One", changes: [], extra: [guard(1)] });
  ctx.plan.startAction(3);
  await commitChange(ctx, { target, summary: "Three", changes: [], extra: [guard(1), guard(1)] });
  assert.equal(ctx.plan.build(target, "").extra?.length, 3);
  assert.deepEqual(ctx.plan.extraSources(), [1, 3, 3]);
});

test("a write that read a planned row from the database, or a bulk change, is refused", async () => {
  const ctx = await planCtx();
  const target = { table: "deals", id: "dl_a" } as const;
  await commitChange(ctx, { target, summary: "One", changes: [{ table: "deals", id: "dl_a", before: deal(3), after: deal(4) }] });
  assert.throws(
    () => ctx.plan.record(ctx, { target, summary: "Two", changes: [{ table: "deals", id: "dl_a", before: deal(3), after: deal(4, { value: 1 }) }] }),
    /deals:dl_a was read from the database after an earlier action planned it/,
  );
  assert.throws(() => ctx.plan.record(ctx, { target, summary: "Big", changes: [], bulk: true }), /bulk/);
});
