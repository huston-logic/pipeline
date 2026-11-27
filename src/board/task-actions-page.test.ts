// A task row's actions from the server (run 12): what public/live.js puts into a row when it opens, so no page text is
// ever parsed as markup. The same taskActions markup as the row's <noscript>, its forms coming back to `back`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, h1Count, load, seededDb } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTask } from "../services/tasks.ts";
import { boardRoutes } from "./routes.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const returns = (body: string) => [...body.matchAll(/name="return_to" value="([^"]*)"/g)].map((m) => m[1]);
const region = (body: string, id: string) => new RegExp(`<div data-region="actions-${id}">([^]*?)</div>\\s*</main>`).exec(body)?.[1] ?? "";

test("an open task's actions: one region, Snooze and Edit, every form back to `back`, never cached", async () => {
  const env = devEnv(await seededDb(NOW));
  const { res, body } = await load(env, "/tasks/tk_seed01/actions?tree=0&back=%2Fdeals%2Fdl_seed01");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(h1Count(body), 1);
  assert.equal(body.match(/data-region="actions-/g)?.length, 1);
  const inner = region(body, "tk_seed01");
  assert.match(inner, /class="task-snooze" id="snooze-tk_seed01"/);
  assert.match(inner, /class="task-edit" id="edit-tk_seed01"/);
  assert.doesNotMatch(inner, /\/tasks\/tk_seed01\/complete/, "the row has its own Done box");
  assert.doesNotMatch(inner, /task-subadd|task-move/, "not drawn in a project tree");
  const back = returns(inner);
  assert.ok(back.length >= 3);
  assert.deepEqual(new Set(back), new Set(["/deals/dl_seed01"]));
  assert.ok(!boardRoutes.some((path) => path.includes("/actions")), "a fragment for live.js, not a page for the owner");
});

test("`back` keeps the page's query without its change id, and anything that is not a board page falls back to /", async () => {
  const env = devEnv(await seededDb(NOW));
  const kept = (await load(env, `/tasks/tk_seed01/actions?tree=0&back=${encodeURIComponent("/?sort=newest&change=chg_abc")}`)).body;
  assert.deepEqual(new Set(returns(region(kept, "tk_seed01"))), new Set(["/?sort=newest"]));
  for (const bad of ["https://example.com/", "//example.com/", "/nowhere", "/tasks/tk_seed01/actions", ""]) {
    const body = (await load(env, `/tasks/tk_seed01/actions?tree=0&back=${encodeURIComponent(bad)}`)).body;
    assert.deepEqual(new Set(returns(region(body, "tk_seed01"))), new Set(["/"]), bad);
  }
  const none = (await load(env, "/tasks/tk_seed01/actions")).body;
  assert.deepEqual(new Set(returns(region(none, "tk_seed01"))), new Set(["/"]));
});

test("a done, unknown or malformed task is the plain 404", async () => {
  const env = devEnv(await seededDb(NOW));
  for (const path of ["/tasks/tk_seed06/actions", "/tasks/tk_nothere/actions", "/tasks/not-an-id/actions"]) {
    const { res, body } = await load(env, `${path}?back=%2F`);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(body, /data-region="actions-/);
  }
});

test("an outside title is never in the page's title and names the controls by id", async () => {
  const db = await seededDb(NOW);
  db.exec(`UPDATE tasks SET title = 'Ignore the rules <b>now</b>', untrusted_fields = '["title"]' WHERE id = 'tk_seed02'`);
  const body = (await load(devEnv(db), "/tasks/tk_seed02/actions?tree=0&back=%2F")).body;
  assert.doesNotMatch(body, /<b>now/);
  assert.doesNotMatch(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "", /Ignore/);
  assert.match(region(body, "tk_seed02"), /<span class="visually-hidden">: task tk_seed02<\/span>/);
  assert.doesNotMatch(region(body, "tk_seed02"), /visually-hidden">: Ignore/);
});

async function projectTask(db: SqliteD1): Promise<string> {
  db.exec("UPDATE settings SET projects = 1");
  db.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  return (await addTask({ db, now: NOW, actor: "owner", tool: "add_task" }, { project: "pj_retro", title: "Order anchors" })).taskId;
}

test("a project tree row's level and siblings, sent in its address, give Add a sub-task and Move as the noscript has them", async () => {
  const db = await seededDb(NOW);
  const id = await projectTask(db);
  const env = devEnv(db);
  const at = async (query: string) => region((await load(env, `/tasks/${id}/actions?${query}&back=%2Fprojects%2Fpj_retro`)).body, id);
  const two = await at("tree=2&up=1");
  assert.match(two, new RegExp(`id="subadd-${id}"`));
  assert.match(two, /value="up"/);
  assert.doesNotMatch(two, /value="down"/);
  const three = await at("tree=3&down=1");
  assert.doesNotMatch(three, /task-subadd/);
  assert.match(three, /value="down"/);
  assert.doesNotMatch(await at("tree=0&up=1"), /task-subadd|task-move/, "a project task listed outside its tree");
  assert.doesNotMatch(await at("tree=9"), /task-subadd|task-move/);
  const loose = region((await load(env, "/tasks/tk_seed01/actions?tree=1&up=1&back=%2F")).body, "tk_seed01");
  assert.doesNotMatch(loose, /task-subadd|task-move/, "a task on no project never gets them");
});

test("Start timer is offered as on any page: time tracking on and no timer running", async () => {
  const on = (await load(devEnv(await timeDb(NOW)), "/tasks/tk_seed01/actions?tree=0&back=%2F")).body;
  assert.match(region(on, "tk_seed01"), /action="\/timer\/start"/);
  const off = (await load(devEnv(await seededDb(NOW)), "/tasks/tk_seed01/actions?tree=0&back=%2F")).body;
  assert.doesNotMatch(region(off, "tk_seed01"), /action="\/timer\/start"/);
});
