// Task forms and the board's task edit (run 12 task A3): Title, Due and Description everywhere, POST /tasks/<id>/edit,
// the description shown (links only for the owner's own text) and a due date with no time shown as the day alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { TaskRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ, zonedToUtc } from "../time.ts";

const task = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();

test("every task form is labelled Title, Due and Description, with no older wording", async () => {
  const env = devEnv(await seededDb());
  const today = (await load(env, "/")).body;
  assert.match(today, /<label for="quick-title">Title <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(today, /<legend>Due<\/legend>|<label for="quick-due">Due<\/label>/);
  assert.doesNotMatch(today, /Add a to-do<\/label>|What to do<\/label>|Due \(optional\)/);
  assert.match(today, /<button class="button" type="submit">Add<\/button>/);
  assert.doesNotMatch(today, /id="quick-description"/, "quick add has no description");
  const deal = (await load(env, "/deals/dl_seed01")).body;
  assert.match(deal, /<label for="task-dl_seed01-title">Title <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(deal, /<label for="task-dl_seed01-description">Description<\/label>/);
  assert.match(deal, /<legend>Due<\/legend>/);
  assert.match(deal, />Add task<\/button>/);
  assert.doesNotMatch(deal, /What to do<\/label>/);
});

test("Edit saves only the fields that changed, as update_task by the owner, and answers 303 with the change", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const { res, location } = await post(env, "/tasks/tk_seed02/edit", {
    title: "Send the price sheet",
    "due.date": "2026-12-02",
    "due.time": "15:00",
    description: "Use https://example.com/prices.",
    return_to: "/",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/\?change=chg_/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_task");
  const row = await task(db, "tk_seed02");
  assert.equal(row?.title, "Send the price sheet");
  assert.equal(row?.due_at, zonedToUtc("2026-12-02T15:00", DEFAULT_TZ).toISOString());
  assert.equal(row?.description, "Use https://example.com/prices.");

  const only = await post(env, "/tasks/tk_seed02/edit", { description: "Just this.", return_to: "/" });
  assert.equal(only.res.status, 303);
  const after = await task(db, "tk_seed02");
  assert.equal(after?.title, "Send the price sheet");
  assert.equal(after?.due_at, row?.due_at, "due left alone");
  assert.equal(after?.description, "Just this.");
});

test("a cleared Due and a cleared Description are sent as null", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  await post(env, "/tasks/tk_seed02/edit", { "due.date": "2026-12-02", "due.time": "", description: "Note", return_to: "/" });
  assert.ok((await task(db, "tk_seed02"))?.due_at);
  const cleared = await post(env, "/tasks/tk_seed02/edit", { "due.date": "", "due.time": "", description: "", return_to: "/" });
  assert.equal(cleared.res.status, 303);
  const row = await task(db, "tk_seed02");
  assert.equal(row?.due_at, null);
  assert.equal(row?.description, null);
});

test("a refused edit is a 422 page with the values kept, and nothing written", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const before = await auditCount(db);
  const blank = await post(env, "/tasks/tk_seed02/edit", { title: "", description: "Keep this text", return_to: "/" });
  assert.equal(blank.res.status, 422);
  assert.equal(h1Count(blank.body), 1);
  assert.match(blank.body, /<h1>The task wasn&#39;t saved<\/h1>/);
  assert.match(blank.body, /Give the task a title\./);
  assert.match(blank.body, />Keep this text<\/textarea>/);
  const bad = await post(env, "/tasks/tk_seed02/edit", { "due.date": "2026-02-31", "due.time": "", return_to: "/" });
  assert.equal(bad.res.status, 422);
  assert.match(bad.body, /Give a real date\./);
  const same = await post(env, "/tasks/tk_seed02/edit", { title: "Send Casey the price sheet", return_to: "/" });
  assert.equal(same.res.status, 422);
  assert.match(same.body, /Nothing to save/);
  assert.equal(await auditCount(db), before);
  assert.equal((await post(env, "/tasks/tk_nothing0000/edit", { title: "x" })).res.status, 404);
});

test("Today draws Edit under each task, shows a description with links only when it is the owner's, and a day alone for a date", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  await post(env, "/tasks/tk_seed02/edit", { "due.date": "2026-12-04", "due.time": "", description: "Prices at https://example.com/p, thanks", return_to: "/" });
  const body = (await load(env, "/")).body;
  assert.match(body, /<details class="task-edit">\n<summary>Edit<span class="visually-hidden">: Send Casey the price sheet<\/span><\/summary>/);
  assert.match(body, /<p class="task-description">Prices at <a href="https:\/\/example\.com\/p" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/p<\/a>, thanks<\/p>/);
  assert.match(body, /<time datetime="[^"]+">Fri Dec 4<\/time>/);
  await db.prepare("UPDATE tasks SET untrusted_fields = '[\"description\"]' WHERE id = 'tk_seed02'").run();
  const outside = (await load(env, "/")).body;
  assert.match(outside, /<p class="task-description"><span class="outside">From outside<\/span> Prices at https:\/\/example\.com\/p, thanks<\/p>/);
  assert.doesNotMatch(outside, /<a href="https:\/\/example\.com\/p"/);
});
