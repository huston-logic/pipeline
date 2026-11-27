// Today is a page of many rows but a few D1 calls (run 12, builder answer 1): at most 20 for the whole render, however
// many tasks, projects and deals are due. Counted with tests/helpers/counting-db.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { seededDb } from "../../tests/helpers/board.ts";
import { matchBoardPage } from "./router.ts";

const MAX_CALLS = 20;

test("the whole Today render makes at most 20 D1 calls, with a full list, projects and deals due", async (t) => {
  const raw = await seededDb();
  raw.exec("UPDATE settings SET projects = 1");
  const stamp = "'2026-01-01T00:00:00.000Z'";
  const projects = Array.from({ length: 12 }, (_, i) => `('pj_load${i}', 'Project ${i}', 'ct_seed01', 'active', ${stamp}, ${stamp})`);
  raw.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES ${projects.join(",")}`);
  const tasks = Array.from(
    { length: 260 },
    (_, i) => `('tk_load${i}', ${i % 3 === 0 ? `'pj_load${i % 12}'` : "NULL"}, ${i % 3 === 0 ? 1 + i : "NULL"}, 'Load task ${i}', '2020-01-0${(i % 9) + 1}T17:00:00.000Z', ${stamp}, ${stamp})`,
  );
  raw.exec(`INSERT INTO tasks (id, project_id, position, title, due_at, created_at, updated_at) VALUES ${tasks.join(",")}`);
  raw.exec("UPDATE deals SET next_at = '2020-01-01T17:00:00.000Z', next_step = 'Call back' WHERE status = 'open'");
  const db = countingDb(raw);
  const page = matchBoardPage("/");
  assert.ok(page);
  const { status, body } = await page({ db, now: new Date(), url: new URL("http://localhost:4821/"), csrf: "token", pushKey: null, emailLogAddress: null });
  assert.equal(status, 200);
  assert.match(body, /class="task-row project-row"/);
  assert.match(body, /class="task-row next-step-row"/);
  t.diagnostic(`${db.calls} D1 calls`);
  assert.ok(db.calls <= MAX_CALLS, `${db.calls} calls:\n${db.log.join("\n")}`);
});
