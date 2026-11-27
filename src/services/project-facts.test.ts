// The facts the project page shows (run 12, ruling 8): the default list, the stored one cleaned, and what
// update_settings accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { checkProjectFacts, PROJECT_FACT_KEYS, projectFacts } from "./view-spec.ts";

const NOW = new Date("2026-11-26T18:00:00.000Z");
const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "ai", tool: "update_settings" });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError);
  return error.message;
}

test("the fact keys are the projects columns but project, plus time", () => {
  assert.deepEqual([...PROJECT_FACT_KEYS], ["status", "person", "deal", "start", "target", "open_tasks", "time"]);
});

test("with nothing stored the default is the standard facts, time only while tracking is on, then every live field", () => {
  const stored = { project_facts: null };
  assert.deepEqual(projectFacts(stored, ["budget", "size"], true), [
    "status", "person", "deal", "start", "target", "time", "fields.budget", "fields.size",
  ]);
  assert.deepEqual(projectFacts(stored, [], false), ["status", "person", "deal", "start", "target"]);
});

test("a stored list keeps its order and drops unknown, archived-field and time-while-off keys", () => {
  const stored = { project_facts: JSON.stringify(["target", "fields.gone", "bogus", "fields.size", "time", "status"]) };
  assert.deepEqual(projectFacts(stored, ["size"], true), ["target", "fields.size", "time", "status"]);
  assert.deepEqual(projectFacts(stored, ["size"], false), ["target", "fields.size", "status"]);
  assert.deepEqual(projectFacts({ project_facts: "[]" }, ["size"], true), []);
  assert.deepEqual(projectFacts({ project_facts: "not json" }, [], false), ["status", "person", "deal", "start", "target"]);
});

test("checkProjectFacts refuses unknown, duplicate and too many keys in plain words", () => {
  assert.deepEqual(checkProjectFacts(["time", "fields.size", "status"], ["size"]), ["time", "fields.size", "status"]);
  assert.deepEqual(checkProjectFacts([], []), []);
  assert.throws(
    () => checkProjectFacts(["status", "colour"], []),
    new UserError("Unknown fact: colour. Choose from status, person, deal, start, target, open_tasks, time, or fields.<key> of a project field."),
  );
  assert.throws(() => checkProjectFacts(["fields.size"], []), /Unknown fact: fields\.size\./);
  assert.throws(() => checkProjectFacts(["status", "status"], []), /status is listed twice/);
  assert.throws(() => checkProjectFacts(Array.from({ length: 21 }, () => "status"), []), /at most 20/);
});

test("update_settings stores the facts, shows the effective list, and null restores the default", async () => {
  const db = await openTestDb();
  const bad = await refusal(updateSettings(ctxFor(db), { projectFacts: ["nope"] }));
  assert.match(bad, /^Unknown fact: nope\./);
  const result = await updateSettings(ctxFor(db), { projectFacts: ["target", "status"] });
  assert.equal(result.summary, `Updated settings: project facts to target, status (change ${result.changeId})`);
  assert.deepEqual((await getSettings(db)).projectFacts, ["target", "status"]);
  const cleared = await updateSettings(ctxFor(db), { projectFacts: null });
  assert.equal(cleared.summary, `Updated settings: project facts back to the default (change ${cleared.changeId})`);
  assert.deepEqual((await getSettings(db)).projectFacts, ["status", "person", "deal", "start", "target"]);
  assert.match(await refusal(updateSettings(ctxFor(db), { projectFacts: null })), /Nothing to change/);
});
