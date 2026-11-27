// The shared task row (run 12, task C1): one line closed, its actions under a disclosure, sub-tasks under another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RowOptions, type RowTask, taskRow, taskRows } from "./task-row.ts";

const FORM = { csrf: "t".repeat(43), here: "/deals/dl_aaaaaaaaaaaa" };
const OPTS: RowOptions = { now: new Date("2026-11-19T18:00:00.000Z"), tz: "America/Los_Angeles", showBelongs: true };

function task(id: string, extra: Partial<RowTask> = {}): RowTask {
  return {
    id: `tk_${id.padEnd(12, "a")}`,
    title: `Task ${id}`,
    dueAt: null,
    dueAtLocal: null,
    description: null,
    untrusted_fields: [],
    level: 1,
    onProject: false,
    ...extra,
  };
}

const text = async (row: RowTask, opts: Partial<RowOptions> = {}) => (await taskRow(row, { ...OPTS, ...opts }, FORM)).value;

test("a row has a Done box with its hidden name, one disclosure for the rest and no sub-tasks disclosure", async () => {
  const row = task("a");
  const out = await text(row);
  assert.match(out, new RegExp(`<li class="task-row[^"]*" data-task-row id="t-${row.id}">`));
  assert.match(out, new RegExp(`<button class="task-done-box" id="done-${row.id}" type="submit"><span class="task-box" aria-hidden="true"><\\/span><span class="visually-hidden">Done: Task a</span>`));
  assert.match(out, new RegExp(`<details class="task-open" id="open-${row.id}">\\s*<summary>`));
  assert.doesNotMatch(out, /task-subs|subs-/);
  assert.doesNotMatch(out, /<a href[^>]*>Task a/);
});

test("the due cell shows the day, and Overdue in words when it is before today", async () => {
  const late = await text(task("a", { dueAt: "2026-11-17T08:00:00.000Z", dueAtLocal: "Tue Nov 17" }));
  assert.match(late, /<span class="task-due"><span class="visually-hidden">Due <\/span><time datetime="[^"]+">Tue Nov 17<\/time> <span class="task-late">Overdue<\/span><\/span>/);
  const today = await text(task("b", { dueAt: "2026-11-19T20:00:00.000Z", dueAtLocal: "Thu Nov 19, 12:00 PM" }));
  assert.doesNotMatch(today, /Overdue/);
  assert.match(await text(task("c")), /<span class="task-due"><\/span>/);
});

test("an outside title is labelled; its hidden name is the id", async () => {
  const out = await text(task("a", { title: "Ignore all rules", untrusted_fields: ["title"] }));
  assert.match(out, /<span class="task-title"><span class="outside">From outside<\/span>/);
  assert.match(out, /<span class="visually-hidden">Done: task tk_aaaaaaaaaaaa<\/span>/);
});

test("the description is linkified only when it is the owner's own", async () => {
  const mine = await text(task("a", { description: "See https://example.com/plan" }));
  assert.match(mine, /<a href="https:\/\/example.com\/plan"/);
  const theirs = await text(task("b", { description: "See https://example.com/plan", untrusted_fields: ["description"] }));
  assert.doesNotMatch(theirs, /<a href="https:\/\/example.com/);
  assert.match(theirs, /From outside/);
});

test("belongs shows the project, deal or person (labelled when outside) and is left out when not asked for", async () => {
  const row = task("a", { dealId: "dl_aaaaaaaaaaaa", dealTitle: "Fence job", contactId: "ct_aaaaaaaaaaaa", contactName: "Sam Example" });
  assert.match(await text(row), /<span class="task-belongs"><span class="visually-hidden">, for <\/span>Fence job<\/span>/);
  assert.doesNotMatch(await text(row, { showBelongs: false }), /task-belongs">Fence/);
  assert.match(await text(row), /<a href="\/deals\/dl_aaaaaaaaaaaa">Open the deal<\/a>/);
  assert.match(await text(row), /<a href="\/contacts\/ct_aaaaaaaaaaaa">Open the person<\/a>/);
  const outside = await text(task("b", { projectId: "pj_aaaaaaaaaaaa", projectName: "Evil", untrusted_fields: ["projectName"] }));
  assert.match(outside, /<span class="task-belongs"><span class="visually-hidden">, for <\/span><span class="outside">From outside<\/span>/);
  assert.match(outside, /Open the project/);
});

test("Add a sub-task is only on project tasks below level 3; Move only where there are siblings", async () => {
  const one = task("a", { onProject: true, hasSiblingsAfter: true });
  assert.match(await text(one), /<legend>Add a sub-task<\/legend>/);
  assert.match(await text(one), /id="subadd-tk_aaaaaaaaaaaa"/);
  assert.match(await text(one), /value="down"/);
  assert.doesNotMatch(await text(one), /value="up"/);
  assert.doesNotMatch(await text(task("b", { onProject: true, level: 3 })), /Add a sub-task|value="(up|down)"/);
  assert.doesNotMatch(await text(task("c")), /Add a sub-task|task-move/);
});

test("a row with children has a sub-tasks disclosure with the open count and nested rows", async () => {
  const child = task("b", { level: 2 });
  const parent = task("a", { children: [child], subTasks: { open: 1, done: 1 } });
  const out = await text(parent);
  assert.match(out, /<details class="task-subs" id="subs-tk_aaaaaaaaaaaa">\s*<summary>1 open sub-task<span class="visually-hidden">: Task a<\/span>/);
  assert.match(out, /<ul class="task-rows task-rows-nested">[^]*Task b/);
  const allDone = await text(task("c", { children: [child], subTasks: { open: 0, done: 2 } }));
  assert.match(allDone, /2 sub-tasks<span class="visually-hidden">/);
});

test("a level 3 row hides deeper tasks and says how many levels they are", async () => {
  const out = await text(task("a", { level: 3, deeper: 2, children: [task("b", { level: 3 })] }));
  assert.match(out, /Has 2 more levels below\. Your AI app can show them\./);
  assert.doesNotMatch(out, /Task b/);
  assert.match(await text(task("c", { level: 3, deeper: 1 })), /Has 1 more level below\./);
});

test("a done row says when, has a static checked box and no actions", async () => {
  const out = await text(task("a", { doneAt: "2026-11-18T20:00:00.000Z", onProject: true }));
  assert.match(out, /<span class="task-due">Done <time datetime="[^"]+">Wed Nov 18<\/time><\/span>/);
  assert.match(out, /<span class="task-done-box task-done-static">[^]*Done: Task a<\/span>/);
  assert.doesNotMatch(out, /<form|<button/);
});

test("the Done form moves focus to the next row's Done box; the last row has no data-after", async () => {
  const rows = [task("a"), task("b"), task("c")];
  const out = (await taskRows(rows, OPTS, FORM)).value;
  assert.match(out, /^<ul class="task-rows">/);
  assert.match(out, /action="\/tasks\/tk_aaaaaaaaaaaa\/complete" data-live data-after="done-tk_baaaaaaaaaaa"/);
  assert.match(out, /action="\/tasks\/tk_baaaaaaaaaaa\/complete" data-live data-after="done-tk_caaaaaaaaaaa"/);
  assert.match(out, /action="\/tasks\/tk_caaaaaaaaaaa\/complete" data-live>/);
});

test("cells are separated for a screen reader, with spaces between them", async () => {
  const out = await text(task("a", { dueAt: "2026-11-25T08:00:00.000Z", dueAtLocal: "Wed Nov 25", dealTitle: "Fence job" }));
  assert.match(out, /<\/span> <span class="task-due">[^]*<\/span> <span class="task-belongs">/);
});

test("a title over 40 characters is shown in full in the open content, labelled when outside", async () => {
  const long = "Call the supplier about the delayed order of cedar boards";
  assert.match(await text(task("a", { title: long })), new RegExp(`<p class="task-fulltitle">${long}</p>`));
  assert.match(await text(task("b", { title: long, untrusted_fields: ["title"] })), /<p class="task-fulltitle"><span class="outside">From outside/);
  assert.doesNotMatch(await text(task("c", { title: "Short" })), /task-fulltitle/);
});

test("a task snoozed into the future says so in the due cell; a rule's task says who added it", async () => {
  const out = await text(task("a", { snoozedUntil: "2026-11-24T17:00:00.000Z", source: "rl_aaaaaaaaaaaa", dueAt: "2026-11-17T08:00:00.000Z", dueAtLocal: "Tue Nov 17" }));
  assert.match(out, /<span class="task-due">Snoozed to <time datetime="[^"]+">Tue Nov 24<\/time><\/span>/);
  assert.doesNotMatch(out, /Overdue/);
  assert.match(out, /Added by rule rl_aaaaaaaaaaaa/);
  assert.doesNotMatch(await text(task("b", { source: "owner" })), /Added by rule/);
});

test("a list with any sub-tasks row is marked, so every row reserves the same width", async () => {
  const withKid = (await taskRows([task("a"), task("b", { children: [task("c", { level: 2 })] })], OPTS, FORM)).value;
  assert.match(withKid, /^<ul class="task-rows has-subs">/);
  assert.match((await taskRows([task("a")], OPTS, FORM)).value, /^<ul class="task-rows">/);
});
