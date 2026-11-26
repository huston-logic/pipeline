// The Pending changes page (run 10, area 5): the open lists, Approve, Discard, the approval setting and the Today notice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { ProposalRow, SettingsRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { RecordAction } from "../services/proposal-actions.ts";
import { proposeChanges } from "../services/proposals.ts";

const TASK: RecordAction[] = [{ action: "add_task", contact: "Pat", title: "Send Pat the booking page examples" }];
const MOVE: RecordAction[] = [{ action: "update_deal", deal: "Pat", stage: "Proposal sent" }];

async function propose(db: SqliteD1, actions: RecordAction[], now = new Date()): Promise<string> {
  const answer = await proposeChanges({ db, now, actor: "ai", tool: "propose_changes" }, { actions }, { extraOwnerEmails: [] });
  assert.equal(answer.kind, "proposal");
  return answer.kind === "proposal" ? answer.id : "";
}

const status = async (db: SqliteD1, id: string) => (await db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>())?.status;

test("the page lists only open, unexpired lists, with named buttons", async () => {
  const db = await seededDb();
  const open = await propose(db, TASK);
  const dropped = await propose(db, MOVE);
  await db.prepare("UPDATE proposals SET status = 'dropped' WHERE id = ?").bind(dropped).run();
  const old = await propose(db, TASK, new Date(Date.now() - 3 * 60 * 60 * 1000));
  const { res, body } = await load(devEnv(db), "/pending");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<title>Pending changes/);
  assert.match(body, new RegExp(`action="/pending/${open}/approve"`));
  assert.match(body, new RegExp(`action="/pending/${open}/discard"`));
  assert.doesNotMatch(body, new RegExp(dropped));
  assert.doesNotMatch(body, new RegExp(old));
  assert.match(body, /<h2>List from \d{1,2}:\d{2} [AP]M, 1 change<\/h2>/);
  assert.match(body, /Approve<span class="visually-hidden"> the list from \d{1,2}:\d{2} [AP]M, 1 change<\/span>/);
  assert.match(body, /aria-describedby="discard-pr_[a-z0-9]+">Discard/);
  assert.match(body, /Discard throws this list away\. It can't be undone, but your AI app can suggest it again\./);
  assert.match(body, /Pat/);
});

test("two lists made in the same minute get different button names", async () => {
  const db = await seededDb();
  await propose(db, TASK);
  await propose(db, TASK);
  const { body } = await load(devEnv(db), "/pending");
  assert.match(body, /Approve<span class="visually-hidden"> the list from [^<]*, 1 change<\/span>/);
  assert.match(body, /Approve<span class="visually-hidden"> the list from [^<]*, 1 change \(2\)<\/span>/);
});

test("an expired list can't be approved or discarded, and an applied one's second Approve shows no old banner", async () => {
  const db = await seededDb();
  const old = await propose(db, TASK, new Date(Date.now() - 3 * 60 * 60 * 1000));
  const before = await auditCount(db);
  const approved = await post(devEnv(db), `/pending/${old}/approve`, {});
  assert.equal(approved.res.status, 422);
  assert.match(approved.body, /expired/);
  assert.equal(await auditCount(db), before);
  const discarded = await post(devEnv(db), `/pending/${old}/discard`, {});
  assert.equal(discarded.res.status, 422);
  assert.equal(await status(db, old), "open");

  const id = await propose(db, TASK);
  await post(devEnv(db), `/pending/${id}/approve`, {});
  const written = await auditCount(db);
  const again = await post(devEnv(db), `/pending/${id}/approve`, {});
  assert.equal(again.res.status, 303);
  assert.equal(again.location, "/pending");
  assert.equal(await auditCount(db), written);
});

test("with nothing waiting the page says so, and shows the approval setting", async () => {
  const db = await seededDb();
  const { body } = await load(devEnv(db), "/pending");
  assert.match(body, /Nothing is waiting for you\./);
  assert.match(body, /<legend>Where AI changes are approved<\/legend>/);
  assert.match(body, /id="approve-chat"[^>]*checked/);
  assert.doesNotMatch(body, /id="approve-board"[^>]*checked/);
  assert.match(body, /Nothing your AI app proposes is saved until you do, small changes and changes to your rules included\./);
});

test("Approve applies the list as the owner and shows the Undo banner", async () => {
  const db = await seededDb();
  const id = await propose(db, TASK);
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), `/pending/${id}/approve`, {});
  assert.equal(res.status, 303);
  assert.match(location, /^\/pending\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "apply_changes");
  assert.equal(await status(db, id), "applied");
  const after = await load(devEnv(db), location);
  assert.match(after.body, /Undo/);
  assert.match(after.body, /Nothing is waiting for you\./);
});

test("a list whose records changed since is a 422 and writes nothing", async () => {
  const db = await seededDb();
  const id = await propose(db, MOVE);
  await db.prepare("UPDATE deals SET version = version + 1 WHERE id = 'dl_seed01'").run();
  const before = await auditCount(db);
  const { res, body } = await post(devEnv(db), `/pending/${id}/approve`, {});
  assert.equal(res.status, 422);
  assert.match(body, /This list changed since it was made\. Ask your AI app for a new one\./);
  assert.doesNotMatch(body, /Propose the changes again/);
  assert.match(body, /href="\/pending"/);
  assert.equal(h1Count(body), 1);
  assert.equal(await auditCount(db), before);
  assert.equal(await status(db, id), "open");
});

test("Discard drops the list without a change, and a second Discard is a 422", async () => {
  const db = await seededDb();
  const id = await propose(db, TASK);
  const before = await auditCount(db);
  const { res, location } = await post(devEnv(db), `/pending/${id}/discard`, {});
  assert.equal(res.status, 303);
  assert.equal(location, "/pending");
  assert.equal(await status(db, id), "dropped");
  assert.equal(await auditCount(db), before);
  const again = await post(devEnv(db), `/pending/${id}/discard`, {});
  assert.equal(again.res.status, 422);
  assert.equal((await post(devEnv(db), "/pending/not-an-id/discard", {})).res.status, 404);
});

test("the setting form sets board and chat as the owner", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const on = await post(env, "/pending/approval", { approve_in: "board" });
  assert.equal(on.res.status, 303);
  assert.match(on.location, /^\/pending\?change=chg_/);
  assert.equal((await auditOf(db, changeIdOf(on.location)))?.actor, "owner");
  assert.equal((await db.prepare("SELECT * FROM settings").first<SettingsRow>())?.ai_approval, "board");
  assert.match((await load(env, "/pending")).body, /id="approve-board"[^>]*checked/);
  const off = await post(env, "/pending/approval", { approve_in: "chat" });
  assert.equal(off.res.status, 303);
  assert.equal((await db.prepare("SELECT * FROM settings").first<SettingsRow>())?.ai_approval, "chat");
  assert.equal((await post(env, "/pending/approval", { approve_in: "nope" })).res.status, 422);
});

test("Today shows the notice only while a list waits, and More lists Pending changes", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  assert.doesNotMatch((await load(env, "/")).body, /from your AI app/);
  await propose(db, TASK);
  const today = (await load(env, "/")).body;
  assert.match(today, /<a class="button button-quiet" href="\/pending">1 change from your AI app is waiting\. Review it\.<\/a>/);
  assert.match((await load(env, "/more")).body, /href="\/pending"[^]*Pending changes/);
});

test("the card shows the owner's list: no AI-directed lines, headings as headings, a plan nested three deep", async () => {
  const db = await seededDb();
  const id = await propose(db, TASK);
  const text = [
    `Proposal ${id} (expires 5:00 PM). Nothing has changed yet.`,
    "",
    "Add",
    "- Project Sign: person Pat Example",
    "  - Design",
    "    - Mockups",
    "      - Logo",
    "Tasks",
    "- Task Call Pat",
    "",
    `Show this list to the owner as it is. Their answer: "Yes" (call apply_changes with ${id}), or "No" (apply nothing).`,
  ].join("\n");
  await db.prepare("UPDATE proposals SET text = ? WHERE id = ?").bind(text, id).run();
  const { body } = await load(devEnv(db), "/pending");
  assert.doesNotMatch(body, /apply_changes|Show this list|Nothing has changed yet|Proposal pr_/);
  assert.match(body, /<h3 class="list-heading">Add<\/h3>/);
  assert.match(body, /<h3 class="list-heading">Tasks<\/h3>/);
  assert.match(body, /<li>Design<ul class="sub-rows"><li>Mockups<ul class="sub-rows"><li>Logo<\/li><\/ul><\/li><\/ul><\/li>/);
  assert.match(body, /<li>Task Call Pat<\/li>/);
});

test("Approve of a list that marks one deal Won goes on to Start a project while projects are on", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE settings SET projects = 1").run();
  const id = await propose(db, [{ action: "update_deal", deal: "dl_seed05", status: "won" }]);
  const { res, location } = await post(devEnv(db), `/pending/${id}/approve`, {});
  assert.equal(res.status, 303);
  assert.match(location, /^\/deals\/dl_seed05\/projects\/new\?change=chg_[a-z0-9]{12}$/);
});
