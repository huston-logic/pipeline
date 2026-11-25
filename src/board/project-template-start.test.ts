// Start a project from a template (run 10, area 4, decision 0059): the Template choice on the three Start a project
// screens (None by default, Show tasks as a GET form), the preview, the hidden field, and the post that copies the tree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTemplate } from "../services/templates.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function startDb(options: { templates?: boolean; on?: boolean } = {}): Promise<{ db: SqliteD1; website: string; plain: string }> {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET projects = 1");
  if (options.templates === false) return { db, website: "", plain: "" };
  const ctx = { db, now: NOW, actor: "owner" as const, tool: "add_template" };
  const website = await addTemplate(ctx, { name: "Website build", tasks: [{ title: "Kickoff call", dueDays: 0 }, { title: "Design pages", dueDays: 7 }, { title: "Home mockup", dueDays: 5, under: 2 }] });
  const plain = await addTemplate(ctx, { name: "Checklist", tasks: [{ title: "Gather files" }] });
  return { db, website: website.templateId, plain: plain.templateId };
}

const SCREENS = ["/contacts/ct_seed01/projects/new", "/deals/dl_seed07/projects/new", "/projects/new"];

test("every Start a project screen offers None (checked) and each live template, in a GET form", async () => {
  const { db, website } = await startDb();
  for (const path of SCREENS) {
    const { res, body } = await load(devEnv(db), path);
    assert.equal(res.status, 200, path);
    assert.match(body, new RegExp(`<form class="template-choice" method="get" action="${path}">`));
    assert.match(body, /<legend>Start from a template<\/legend>/);
    assert.match(body, /<input id="template-none" name="template" type="radio" value="" checked><label for="template-none">None<\/label>/);
    assert.match(body, new RegExp(`value="${website}"><label for="template-${website}">Website build</label>`));
    assert.match(body, />Show tasks<\/button>/);
    assert.doesNotMatch(body, /type="hidden" name="template"/);
  }
});

test("a chosen template shows its tasks above the form, with the start-today line, and the form carries it", async () => {
  const { db, website } = await startDb();
  const { body } = await load(devEnv(db), `/projects/new?template=${website}`);
  assert.match(body, /Tasks from Website build/);
  assert.match(body, /Starts today unless you set a start date\./);
  assert.match(body, /Kickoff call/);
  assert.match(body, /Home mockup/);
  assert.match(body, /Day 7/);
  assert.match(body, new RegExp(`value="${website}" checked`));
  assert.match(body, new RegExp(`<input type="hidden" name="template" value="${website}">`));
  assert.ok(body.indexOf("Tasks from Website build") < body.indexOf('name="name"'));
});

test("a template with no offsets has no start-today line", async () => {
  const { db, plain } = await startDb();
  const { body } = await load(devEnv(db), `/projects/new?template=${plain}`);
  assert.match(body, /Gather files/);
  assert.doesNotMatch(body, /Starts today unless/);
});

test("an unknown or archived template id falls back to None", async () => {
  const { db, plain } = await startDb();
  db.exec(`UPDATE project_templates SET archived = 1 WHERE id = '${plain}'`);
  for (const asked of ["tp_nope", "Website%20build", plain]) {
    const { res, body } = await load(devEnv(db), `/projects/new?template=${asked}`);
    assert.equal(res.status, 200);
    assert.match(body, /id="template-none" name="template" type="radio" value="" checked/);
    assert.doesNotMatch(body, /Tasks from/);
    assert.doesNotMatch(body, /type="hidden" name="template"/);
  }
});

test("with no live templates the fieldset is not shown", async () => {
  const { db } = await startDb({ templates: false });
  for (const path of SCREENS) {
    const { body } = await load(devEnv(db), path);
    assert.doesNotMatch(body, /Start from a template/, path);
  }
});

test("while projects are off the screens are still 404", async () => {
  const { db } = await startDb({ on: false, templates: false });
  for (const path of SCREENS) assert.equal((await load(devEnv(db), path)).res.status, 404, path);
});

test("saving with a template copies its tree in one add_project change", async () => {
  const { db, website } = await startDb();
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/contacts/ct_seed01/projects", { name: "Salon site", status: "active", template: website });
  assert.equal(res.status, 303);
  assert.equal(await auditCount(db), before + 1);
  assert.equal((await auditOf(db, changeIdOf(location)))?.tool, "add_project");
  const made = await db.prepare("SELECT id, start_at FROM projects WHERE name = 'Salon site'").first<{ id: string; start_at: string | null }>();
  assert.ok(made);
  assert.ok(made.start_at !== null);
  const tasks = (await db.prepare("SELECT title FROM tasks WHERE project_id = ? ORDER BY title").bind(made.id).all<{ title: string }>()).results.map((row) => row.title);
  assert.deepEqual(tasks, ["Design pages", "Home mockup", "Kickoff call"]);
});

test("a refused post with a template keeps the choice and its preview", async () => {
  const { db, website } = await startDb();
  const { res, body } = await post(devEnv(db), "/projects/new", { name: "", status: "active", template: website });
  assert.equal(res.status, 422);
  assert.match(body, /Tasks from Website build/);
  assert.match(body, new RegExp(`<input type="hidden" name="template" value="${website}">`));
});

test("a post naming an unknown template is refused and writes nothing", async () => {
  const { db } = await startDb();
  const before = await auditCount(db);
  const { res } = await post(devEnv(db), "/projects/new", { name: "Wall", status: "active", template: "tp_nope" });
  assert.equal(res.status, 422);
  assert.equal(await auditCount(db), before);
});

test("the deal screen keeps its task boxes with a template, and the redirect after Won lands on the choice", async () => {
  const { db, website } = await startDb();
  const env = devEnv(db);
  const won = await post(env, "/deals/dl_seed01/move", { stage: "won", confirm: "yes", return_to: "/pipeline" });
  assert.match(won.location, /^\/deals\/dl_seed01\/projects\/new\?change=/);
  const next = await load(env, won.location);
  assert.match(next.body, /Start from a template/);
  assert.match(next.body, /<div class="banner" role="status">/);
  assert.match(next.body, /Choose a template, then press Show tasks to use it\./);
  assert.match(next.body, /aria-describedby="template-hint"/);
  assert.match(next.body, /<input type="hidden" name="change" value="chg_[a-z0-9]{12}">/);
  const open = await load(env, `${won.location}&template=${website}`);
  assert.match(open.body, new RegExp(`<input type="hidden" name="template" value="${website}">`));
  const { res } = await post(env, "/deals/dl_seed01/projects", { name: "Site", status: "active", template: website, move_tasks: "yes" });
  assert.equal(res.status, 303);
});
