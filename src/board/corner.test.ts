// The status corner (run 12): the timer chip, the latest change, and the Time logged note.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import { getSettings } from "../db/queries.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { ChangeItem } from "../services/read.ts";
import { completeTask, addTask } from "../services/tasks.ts";
import { cancelTimer, startTimer, stopTimer } from "../services/timer.ts";
import { type CornerState, corner, noticeText } from "./corner.ts";
import { buildCorner } from "./corner-state.ts";

const FORM = { csrf: "t".repeat(43), here: "/pipeline" };
const EMPTY: CornerState = { timer: null, notice: null, logged: null, startTimer: false };
const draw = (state: CornerState) => corner(state, FORM).value;

const change = (overrides: Partial<ChangeItem> = {}): ChangeItem => ({
  changeId: "chg_aaaaaaaaaaaa",
  at: "2026-11-26T20:00:00.000Z",
  actor: "owner",
  tool: "complete_task",
  targetTable: "tasks",
  targetId: "tk_aaaaaaaaaaaa",
  summary: "Completed task tk_aaaaaaaaaaaa",
  undone: false,
  undoneAt: null,
  undoneBy: null,
  undoOf: null,
  ...overrides,
});

test("an empty corner is a region with an empty status line and nothing else", () => {
  const out = draw(EMPTY);
  assert.match(out, /^<div class="corner" data-region="corner">/);
  assert.match(out, /<div class="corner-notice" role="status"><\/div>/);
  assert.doesNotMatch(out, /corner-chip|<form/);
});

test("the chip shows the label, the start, Stop and Undo, outside the live region", () => {
  const out = draw({ ...EMPTY, timer: { label: "Pat Example", since: "9:10 AM", startedAt: "2026-11-26T17:10:00.000Z" } });
  assert.match(out, /<time class="corner-clock" datetime="2026-11-26T17:10:00.000Z" data-since="2026-11-26T17:10:00.000Z">since 9:10 AM<\/time>/);
  assert.match(out, /<span class="corner-what">Pat Example<\/span>/);
  assert.match(out, /<form class="corner-form" method="post" action="\/timer\/stop\/now">[^]*Stop<span class="visually-hidden">: timer for Pat Example<\/span><\/button>/);
  assert.match(out, /<form class="corner-form" data-started="2026-11-26T17:10:00.000Z" method="post" action="\/timer\/cancel">[^]*Undo<span class="visually-hidden"> the timer<\/span><\/button>/);
  assert.ok(out.indexOf("corner-chip") < out.indexOf('role="status"'));
  const live = out.slice(out.indexOf('role="status"'));
  assert.doesNotMatch(live, /corner-clock|corner-chip/);
  assert.doesNotMatch(out, /name="at"/);
});

test("the chip's label is cut to 32 characters with an ellipsis", () => {
  const label = "A".repeat(40);
  const out = draw({ ...EMPTY, timer: { label, since: "9:10 AM", startedAt: "2026-11-26T17:10:00.000Z" } });
  assert.match(out, new RegExp(`<span class="corner-what">${"A".repeat(32)}…</span>`));
  const exact = draw({ ...EMPTY, timer: { label: "B".repeat(32), since: "9:10 AM", startedAt: "x" } });
  assert.doesNotMatch(exact, /…/);
});

test("noticeText names the verb and the record, or only the verb, or falls back to the stored summary", () => {
  const table: [Partial<ChangeItem>, string | null, string][] = [
    [{ tool: "complete_task" }, "Send the plan", "Done: Send the plan"],
    [{ tool: "complete_task" }, "task tk_aaaaaaaaaaaa", "Done: task tk_aaaaaaaaaaaa"],
    [{ tool: "snooze_task" }, "Call back", "Snoozed: Call back"],
    [{ tool: "add_task" }, "Call back", "Added: Call back"],
    [{ tool: "update_task" }, "Call back", "Saved: Call back"],
    [{ tool: "move_task" }, "Call back", "Moved: Call back"],
    [{ tool: "start_timer", targetTable: "time_entries" }, "Pat Example", "Timer started: Pat Example"],
    [{ tool: "stop_timer", targetTable: "time_entries" }, "Pat Example", "Time logged: Pat Example"],
    [{ tool: "cancel_timer", targetTable: "time_entries" }, "Pat Example", "Timer discarded: Pat Example"],
    [{ tool: "log_time", targetTable: "time_entries" }, "Pat Example", "Saved: Pat Example"],
    [{ tool: "undo_change", undoOf: "chg_bbbbbbbbbbbb" }, null, "Undone."],
    [{ tool: "complete_task" }, null, "Done."],
    [{ tool: "move_deal", summary: "Moved a deal to Won" }, "ignored", "Moved a deal to Won"],
  ];
  for (const [overrides, name, expected] of table) assert.equal(noticeText(change(overrides), name), expected);
});

test("a change notice has its text and an Undo; an undone one says Undone. instead", () => {
  const out = draw({ ...EMPTY, notice: { change: change(), name: "Send the plan" } });
  assert.match(out, /<div class="corner-notice" role="status">\s*<p class="corner-text">Done: Send the plan<\/p>/);
  assert.match(out, /action="\/changes\/chg_aaaaaaaaaaaa\/undo"/);
  const undone = draw({ ...EMPTY, notice: { change: change({ undone: true }), name: "Send the plan" } });
  assert.match(undone, /<p class="corner-text">Undone: Send the plan<\/p>/);
  assert.doesNotMatch(undone, /Done: Send|corner-note|\/undo"/);
  assert.match(draw({ ...EMPTY, notice: { change: change({ undone: true }), name: null } }), /<p class="corner-text">Undone\.<\/p>/);
});

test("the Time logged note has the times, an edit link back to this page, Undo and Close, and wins over a notice", () => {
  const out = draw({
    ...EMPTY,
    notice: { change: change(), name: "x" },
    logged: { changeId: "chg_bbbbbbbbbbbb", entryId: "te_aaaaaaaaaaaa", from: "1:16 PM", to: "1:58 PM" },
  });
  assert.match(out, /Time logged: 1:16 PM to 1:58 PM/);
  assert.match(out, /<a class="corner-link" href="\/timer\/notes\?entry=te_aaaaaaaaaaaa&amp;back=%2Fpipeline">Edit or add notes<\/a>/);
  assert.match(out, /action="\/changes\/chg_bbbbbbbbbbbb\/undo"/);
  assert.match(out, /action="\/corner\/close"[^]*name="change" value="chg_bbbbbbbbbbbb"[^]*Close/);
  assert.doesNotMatch(out, /Done: x/);
});

const ctxFor = (db: SqliteD1, now: Date, tool: string) => ({ db, now, actor: "owner" as const, tool });

async function corner_(db: SqliteD1, now: Date, options: { change?: string; closed?: string } = {}) {
  const settings = await getSettings(db);
  return buildCorner(db, now, settings, { changeId: options.change ?? null, closed: options.closed ?? null });
}

async function ranTimer(minutesAgo: number, tool: "stop_timer" | "cancel_timer" = "stop_timer") {
  const stopAt = new Date();
  const db = await timeDb(stopAt);
  const begin = new Date(stopAt.getTime() - minutesAgo * 60_000 - 30 * 60_000);
  await startTimer(ctxFor(db, begin, "start_timer"), { contact: "ct_seed01" });
  const ended =
    tool === "stop_timer"
      ? await stopTimer(ctxFor(db, new Date(stopAt.getTime() - minutesAgo * 60_000), "stop_timer"), {})
      : await cancelTimer(ctxFor(db, new Date(stopAt.getTime() - minutesAgo * 60_000), "cancel_timer"));
  return { db, now: stopAt, changeId: ended.changeId };
}

test("a timer that just stopped shows the Time logged note, for two minutes", async () => {
  const { db, now, changeId } = await ranTimer(1);
  const state = await corner_(db, now);
  assert.equal(state.timer, null);
  assert.equal(state.logged?.changeId, changeId);
  assert.match(state.logged?.entryId ?? "", /^te_/);
  assert.match(state.logged?.from ?? "", /^\d{1,2}:\d{2} [AP]M/);
  const late = await ranTimer(3);
  assert.equal((await corner_(late.db, late.now)).logged, null, "three minutes on, it is gone");
});

test("the note is gone when its change is the closed cookie's, was undone, or a cancel or newer start came after", async () => {
  const { db, now, changeId } = await ranTimer(1);
  assert.equal((await corner_(db, now, { closed: changeId })).logged, null);
  assert.equal((await corner_(db, now, { closed: "chg_zzzzzzzzzzzz" })).logged?.changeId, changeId);
  await db.prepare("UPDATE audit_log SET undone_at = ? WHERE id = ?").bind(now.toISOString(), changeId).run();
  assert.equal((await corner_(db, now)).logged, null, "undone");

  const cancelled = await ranTimer(1, "cancel_timer");
  assert.equal((await corner_(cancelled.db, cancelled.now)).logged, null, "a discard is not Time logged");

  const again = await ranTimer(1);
  await startTimer(ctxFor(again.db, new Date(again.now.getTime() - 1000), "start_timer"), { contact: "ct_seed01" });
  const running = await corner_(again.db, again.now);
  assert.notEqual(running.timer, null, "a timer runs");
  assert.equal(running.logged, null, "so no note");
  assert.equal(running.startTimer, false);
  assert.equal(running.timer?.label, "Pat Example");
  assert.match(running.timer?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("with time tracking off there is no chip and no note", async () => {
  const { db, now } = await ranTimer(1);
  db.exec("UPDATE settings SET time_tracking = 0");
  const state = await corner_(db, now);
  assert.deepEqual([state.timer, state.logged, state.startTimer], [null, null, false]);
});

test("a change in the address becomes a notice named by its task, and an outside title becomes the task's id", async () => {
  const now = new Date();
  const db = await timeDb(now);
  const added = await addTask(ctxFor(db, now, "add_task"), { title: "Send the plan" });
  const done = await completeTask(ctxFor(db, now, "complete_task"), added.taskId);
  const seen = await corner_(db, now, { change: done.changeId });
  assert.equal(seen.notice === null ? "" : noticeText(seen.notice.change, seen.notice.name), "Done: Send the plan");

  await db.prepare("UPDATE tasks SET untrusted_fields = ? WHERE id = ?").bind('["title"]', added.taskId).run();
  const outside = await corner_(db, now, { change: done.changeId });
  assert.equal(outside.notice === null ? "" : noticeText(outside.notice.change, outside.notice.name), `Done: task ${added.taskId}`);

  assert.equal((await corner_(db, now, { change: "chg_nopenopenope" })).notice, null);
});
