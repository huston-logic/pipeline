// The timer on the board (decision 0050): Start timer posts, the Stop bar, the stop form and the done page, through the
// Worker. Each write is one audited change by the owner under the MCP tool's name; with time tracking off every timer
// path is a 404.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ActivityRow, TaskRow, TimeEntryRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";

const entries = async (db: SqliteD1) => (await db.prepare("SELECT * FROM time_entries ORDER BY created_at, id").all<TimeEntryRow>()).results;

async function started(db: SqliteD1, fields: Record<string, string> = { contact: "ct_seed01" }) {
  return post(devEnv(db), "/timer/start", { ...fields, return_to: "/contacts/ct_seed01" });
}

test("start then the bar shows on Today", async () => {
  const db = await timeDb(new Date());
  const before = await auditCount(db);
  const { res, location } = await started(db);
  assert.equal(res.status, 303);
  assert.match(location, /^\/contacts\/ct_seed01\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "start_timer");
  const rows = await entries(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ended_at, null);
  assert.equal(rows[0]?.contact_id, "ct_seed01");

  const today = (await load(devEnv(db), "/")).body;
  assert.match(today, /<div class="corner-chip" role="region" aria-label="Running timer">/);
  assert.match(today, /<time class="corner-clock" datetime="[^"]+" data-since="[^"]+">since \d{1,2}:\d{2} [AP]M<\/time>/);
  assert.match(today, /<span class="corner-what">Pat Example<\/span>/);
  assert.match(today, /action="\/timer\/stop\/now" data-live>[^]*Stop<span class="visually-hidden">: timer for Pat Example<\/span>/);
  // Every board page carries it, and a person's page no longer offers a second Start.
  const person = (await load(devEnv(db), "/contacts/ct_seed01")).body;
  assert.match(person, /class="corner-chip"/);
  assert.doesNotMatch(person, /action="\/timer\/start"/);
});

test("a Start timer form is on a person, a deal and a task, with the subject as a hidden field", async () => {
  const db = await timeDb(new Date());
  const env = devEnv(db);
  const person = (await load(env, "/contacts/ct_seed01")).body;
  assert.match(person, /<form class="timer-start" method="post" action="\/timer\/start" data-live>[^]*<input type="hidden" name="contact" value="ct_seed01">[^]*Start timer/);
  const deal = (await load(env, "/deals/dl_seed01")).body;
  assert.match(deal, /action="\/timer\/start" data-live>[^]*<input type="hidden" name="deal" value="dl_seed01">/);
  assert.match(deal, /<input type="hidden" name="task" value="tk_seed\d+">/);
});

test("start while running is 422", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const before = await auditCount(db);
  const second = await started(db, { deal: "dl_seed01" });
  assert.equal(second.res.status, 422);
  assert.match(second.body, /A timer is already running for Pat Example since/);
  assert.equal(h1Count(second.body), 1);
  assert.equal(await auditCount(db), before);
  assert.equal((await entries(db)).length, 1);
});

test("a start for a record that is not there is a refusal, and a malformed id writes nothing", async () => {
  const db = await timeDb(new Date());
  const before = await auditCount(db);
  const gone = await started(db, { contact: "ct_nope" });
  assert.equal(gone.res.status, 422);
  const bad = await started(db, { contact: "<b>" });
  assert.equal(bad.res.status, 422);
  assert.equal(await auditCount(db), before);
});

test("stop saves entry, note and task and redirects to done", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), "/timer/stop", {
    notes: "Sketched the plan.",
    work_type: "wt_design",
    billable: "yes",
    next_step: "2099-01-05",
  });
  assert.equal(res.status, 303);
  assert.match(location, /^\/timer\/done\?entry=(te_[a-z0-9]{12})&task=(tk_[a-z0-9]{12})&change=(chg_[a-z0-9]{12})$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "stop_timer");
  const [entry] = await entries(db);
  assert.ok(entry?.ended_at !== null && entry?.minutes === 1);
  assert.equal(entry?.work_type_id, "wt_design");
  assert.equal(entry?.billable, 1);
  assert.equal(entry?.rate, 95);
  assert.equal(entry?.notes, "Sketched the plan.");
  const activity = await db.prepare("SELECT * FROM activities WHERE id = ?").bind(entry?.activity_id ?? "").first<ActivityRow>();
  assert.equal(activity?.summary, "Sketched the plan.");
  assert.equal(activity?.actor, "owner");
  const task = await db.prepare("SELECT * FROM tasks WHERE title = 'Next step' AND contact_id = 'ct_seed01'").first<TaskRow>();
  assert.ok(task?.due_at?.startsWith("2099-01-0"));

  const done = await load(devEnv(db), location);
  assert.equal(done.res.status, 200);
  assert.equal(h1Count(done.body), 1);
  assert.match(done.body, /1 min/);
  assert.match(done.body, /Design/);
  assert.match(done.body, /<dt>Billable<\/dt><dd>Yes<\/dd>/);
  assert.match(done.body, /<dt>Rate<\/dt><dd>\$95\.00\/h<\/dd>/);
  assert.match(done.body, /<dt>Amount<\/dt><dd>\$1\.58<\/dd>/);
  assert.match(done.body, /<dt>For<\/dt><dd><a href="\/contacts\/ct_seed01">Pat Example<\/a>/);
  assert.match(done.body, /<a href="\/contacts\/ct_seed01">On the timeline<\/a>/);
  assert.match(done.body, /<a href="\/contacts\/ct_seed01">Next step task<\/a>/);
  assert.match(done.body, /Ask Claude to turn these notes into updates/);
  assert.doesNotMatch(done.body, /class="corner-chip"/, "the timer is stopped, so no chip");
  assert.match(done.body, /Time logged: \d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M/, "and the note says so for two minutes");
});

test("an unchanged start and end are not posted: the timer's own start and the moment of stopping are kept", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const [running] = await entries(db);
  const page = await load(devEnv(db), "/timer/stop");
  assert.match(page.body, /name="was.started" value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
  const was = /name="was.started" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  const [date = "", time = ""] = was.split("T");
  const stopped = await post(devEnv(db), "/timer/stop", { "started.date": date, "started.time": time, "was.started": was, notes: "" }, { cookie: page.cookie, token: page.token });
  assert.equal(stopped.res.status, 303);
  const [entry] = await entries(db);
  assert.equal(entry?.started_at, running?.started_at, "the stored start, with its seconds");
});

test("a refused stop is a 422 with the form again, the values kept, and the timer still running", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const before = await auditCount(db);
  const refused = await post(devEnv(db), "/timer/stop", { notes: "Long day.", "started.date": "2020-01-01", "started.time": "09:00" });
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /at most 16 hours/);
  assert.match(refused.body, /Long day\./);
  assert.equal(h1Count(refused.body), 1);
  assert.equal(await auditCount(db), before);
  assert.equal((await entries(db))[0]?.ended_at, null);
});

test("the stop form: notes, work type with None first, billable, next step date, start and end", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const { body } = await load(devEnv(db), "/timer/stop");
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>What did you do\?<\/h1>/);
  assert.match(body, /<textarea id="stop-notes" name="notes"/);
  assert.match(body, /<select id="stop-work_type" name="work_type">\n<option value="" selected>None<\/option>\n<option value="wt_design">Design<\/option>\n<option value="wt_admin">Admin<\/option>/);
  assert.match(body, /<input id="stop-billable" name="billable" type="checkbox" value="yes">/);
  assert.match(body, /name="next_step" type="date"/);
  assert.match(body, /name="started\.date"/);
  assert.match(body, /name="ended\.date"/);
  assert.match(body, /<button class="button" type="submit">Save time<\/button>/);
});

test("with no timer running the stop page says so and links Today", async () => {
  const db = await timeDb(new Date());
  const { res, body } = await load(devEnv(db), "/timer/stop");
  assert.equal(res.status, 200);
  assert.match(body, /No timer is running\./);
  assert.match(body, /<a class="button" href="\/">Back to Today<\/a>/);
  assert.equal(h1Count(body), 1);
  const posted = await post(devEnv(db), "/timer/stop", { notes: "x" });
  assert.equal(posted.res.status, 422);
  assert.match(posted.body, /No timer is running/);
});

test("the done page for an entry that is not there, or a bad id, is a 404", async () => {
  const db = await timeDb(new Date());
  assert.equal((await load(devEnv(db), "/timer/done?entry=te_nope")).res.status, 404);
  assert.equal((await load(devEnv(db), "/timer/done?entry=<b>")).res.status, 404);
  assert.equal((await load(devEnv(db), "/timer/done")).res.status, 404);
});

test("time tracking off: no Start button, no bar, 404s", async () => {
  const db = await timeDb(new Date(), { on: false });
  const env = devEnv(db);
  for (const path of ["/contacts/ct_seed01", "/deals/dl_seed01", "/"]) {
    const { body } = await load(env, path);
    assert.doesNotMatch(body, /\/timer\/start/, path);
    assert.doesNotMatch(body, /corner-chip/, path);
  }
  assert.equal((await load(env, "/timer/stop")).res.status, 404);
  assert.equal((await load(env, "/timer/done?entry=te_seed01")).res.status, 404);
  const before = await auditCount(db);
  assert.equal((await started(db)).res.status, 404);
  assert.equal((await post(env, "/timer/stop", { notes: "x" })).res.status, 404);
  assert.equal(await auditCount(db), before);
});

/** Starts a timer for Pat (optionally with a work type already on it), stops it with `fields`, answers the entry. */
async function stoppedWith(fields: Record<string, string>, own?: string) {
  const db = await timeDb(new Date());
  await started(db);
  if (own !== undefined) db.exec(`UPDATE time_entries SET work_type_id = '${own}', billable = 1`);
  const { res } = await post(devEnv(db), "/timer/stop", fields);
  assert.equal(res.status, 303);
  return (await entries(db))[0];
}

test("a billable work type chosen with the box untouched saves a billable entry at its rate", async () => {
  // The form drew the box unticked (the timer had no work type), so was.billable is "0" and the box posts nothing.
  const row = await stoppedWith({ work_type: "wt_design", "was.billable": "0" });
  assert.equal(row?.work_type_id, "wt_design");
  assert.equal(row?.billable, 1);
  assert.equal(row?.rate, 95);
});

test("ticking or unticking the box explicitly wins over the work type's default", async () => {
  const unticked = await stoppedWith({ work_type: "wt_design", "was.billable": "1" }, "wt_design");
  assert.equal(unticked?.billable, 0, "drawn ticked, posted unticked");
  assert.equal(unticked?.rate, null);
  const ticked = await stoppedWith({ work_type: "wt_admin", "was.billable": "0", billable: "yes" });
  assert.equal(ticked?.billable, 1, "Admin is not billable by default, but the box was ticked");
  const admin = await stoppedWith({ work_type: "wt_admin", "was.billable": "0" });
  assert.equal(admin?.billable, 0);
});

test("None on a timer that has a work type clears it, and the entry is not billable unless the box is ticked", async () => {
  const db = await timeDb(new Date());
  await started(db);
  db.exec("UPDATE time_entries SET work_type_id = 'wt_design', billable = 1");
  const page = await load(devEnv(db), "/timer/stop");
  assert.match(page.body, /<option value="wt_design" selected>/);
  assert.match(page.body, /name="was\.billable" value="1"/);
  assert.match(page.body, /name="billable" type="checkbox" value="yes" checked/);
  const none = await post(devEnv(db), "/timer/stop", { work_type: "", "was.billable": "1", billable: "yes" }, { cookie: page.cookie, token: page.token });
  assert.equal(none.res.status, 303);
  const [row] = await entries(db);
  assert.equal(row?.work_type_id, null);
  assert.equal(row?.billable, 0, "the box was left as drawn, so the (absent) work type's default decides");
  const ticked = await stoppedWith({ work_type: "", "was.billable": "0", billable: "yes" }, "wt_design");
  assert.equal(ticked?.work_type_id, null);
  assert.equal(ticked?.billable, 1);
});

test("the chip's Stop and Undo name the timer they act on for a screen reader", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const { body } = await load(devEnv(db), "/");
  assert.match(body, /<button class="button corner-button" type="submit">Stop<span class="visually-hidden">: timer for Pat Example<\/span><\/button>/);
  assert.match(body, /Undo<span class="visually-hidden"> the timer<\/span>/);
});

test("the done page links its task only when the address names a real task of the entry's subject", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const stopped = await post(devEnv(db), "/timer/stop", { notes: "Did it.", next_step: "2099-01-05" });
  assert.match(stopped.location, /^\/timer\/done\?entry=te_[a-z0-9]{12}&task=tk_[a-z0-9]{12}&change=chg_[a-z0-9]{12}$/);
  assert.match((await load(devEnv(db), stopped.location)).body, /<a href="\/contacts\/ct_seed01">Next step task<\/a>/);

  const entry = /entry=(te_[a-z0-9]+)/.exec(stopped.location)?.[1] ?? "";
  const without = (await load(devEnv(db), `/timer/done?entry=${entry}`)).body;
  assert.doesNotMatch(without, /Next step task/);
  // tk_seed02 belongs to another person's deal, tk_nope is not there, and a malformed id is ignored.
  for (const task of ["tk_seed02", "tk_nope", "<b>"]) {
    const body = (await load(devEnv(db), `/timer/done?entry=${entry}&task=${encodeURIComponent(task)}`)).body;
    assert.doesNotMatch(body, /Next step task/, task);
  }
  const db2 = await timeDb(new Date());
  await started(db2);
  const plain = await post(devEnv(db2), "/timer/stop", { notes: "No task." });
  assert.doesNotMatch(plain.location, /task=/);
});

test("the done page loads board.js, so Copy prompt can appear", async () => {
  const db = await timeDb(new Date());
  await started(db);
  const stopped = await post(devEnv(db), "/timer/stop", { notes: "Did it." });
  const { body } = await load(devEnv(db), stopped.location);
  assert.match(body, /<script src="\/board\.js" defer><\/script>/);
  assert.match(body, /data-copy="ask-timer"/);
});
