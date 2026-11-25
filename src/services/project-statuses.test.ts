import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { ReadMemo } from "./memo.ts";
import { projectStatusLabels, updateProjectStatus } from "./project-statuses.ts";
import { getSettings, PROJECTS_OFF, requireProjects, updateSettings } from "./settings.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-25T18:00:00.000Z");
const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "ai", tool: "update_project_status" });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

async function projectsOn(db: Db): Promise<void> {
  await updateSettings({ ...ctxFor(db), tool: "update_settings" }, { projects: true });
}

test("the projects setting starts off; update_settings turns it on and off with a summary", async () => {
  const db = await openTestDb();
  assert.equal((await getSettings(db)).projects, false);
  assert.equal(await refusal(requireProjects(db)), PROJECTS_OFF);
  assert.equal(PROJECTS_OFF, "Projects are off. The owner can turn them on (update_settings projects true).");
  const on = await updateSettings(ctxFor(db), { projects: true });
  assert.equal(on.summary, `Updated settings: projects on (change ${on.changeId})`);
  assert.equal((await getSettings(db)).projects, true);
  await requireProjects(db);
  const off = await updateSettings(ctxFor(db), { projects: false });
  assert.match(off.summary, /^Updated settings: projects off \(change /);
  assert.equal((await getSettings(db)).projects, false);
});

test("projectStatusLabels maps key to label, from the database and from a memo", async () => {
  const db = await openTestDb();
  const expected = new Map([
    ["active", "Active"],
    ["on_hold", "On hold"],
    ["done", "Done"],
  ]);
  assert.deepEqual(await projectStatusLabels(db), expected);
  assert.deepEqual(await projectStatusLabels({ db, memo: new ReadMemo(db) }), expected);
});

test("a rename is one undoable change", async () => {
  const db = await openTestDb();
  await projectsOn(db);
  const result = await updateProjectStatus(ctxFor(db), "on_hold", "  Paused ");
  assert.equal(result.summary, `Renamed project status "On hold" to "Paused" (change ${result.changeId})`);
  assert.equal((await projectStatusLabels(db)).get("on_hold"), "Paused");
  await undoChange(ctxFor(db), result.changeId);
  assert.equal((await projectStatusLabels(db)).get("on_hold"), "On hold");
});

test("an unknown key, an empty, long or duplicate label, a same label, and off all refuse plainly", async () => {
  const db = await openTestDb();
  assert.equal(await refusal(updateProjectStatus(ctxFor(db), "on_hold", "Paused")), PROJECTS_OFF);
  await projectsOn(db);
  assert.equal(
    await refusal(updateProjectStatus(ctxFor(db), "paused", "Paused")),
    'There\'s no project status "paused". Use one of: active (Active), on_hold (On hold), done (Done).',
  );
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", "   ")), /needs a label/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", "x".repeat(61))), /at most 60 characters/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", "ACTIVE")), /already a project status called Active \(active\)/);
  assert.match(await refusal(updateProjectStatus(ctxFor(db), "done", "Done")), /Nothing to change/);
  // Changing only the capitals of its own label is a real rename.
  const result = await updateProjectStatus(ctxFor(db), "done", "DONE");
  assert.match(result.summary, /^Renamed project status "Done" to "DONE"/);
});
