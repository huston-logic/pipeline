// Projects in proposals (decision 0055): the list lines, "@n" project refs, name questions, and the Won deals an
// applied list reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import { type Db } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import type { RecordAction } from "./proposal-actions.ts";
import { applyChanges, type ProposeAnswer, proposeChanges } from "./proposals.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };

const ctxFor = (db: Db, tool = "propose_changes"): Ctx => ({ db, now: NOW, actor: "ai", tool });

async function setup(more = "") {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(
    `UPDATE settings SET projects = 1, time_tracking = 1; ${WORK_TYPES_SQL}; ` +
      "INSERT INTO projects (id, name, contact_id, deal_id, start_at, target_at) VALUES " +
      "('pj_seed01', 'Retrofit', 'ct_seed01', NULL, '2026-12-01T08:00:00.000Z', NULL); " +
      more,
  );
  return db;
}

async function propose(db: Db, actions: RecordAction[]): Promise<Extract<ProposeAnswer, { kind: "proposal" }>> {
  const answer = await proposeChanges(ctxFor(db), { actions }, DEPS);
  assert.equal(answer.kind, "proposal", JSON.stringify(answer));
  return answer as Extract<ProposeAnswer, { kind: "proposal" }>;
}

const lines = (text: string, heading: string) => {
  const all = text.split("\n");
  const from = all.indexOf(heading);
  const rest = all.slice(from + 1);
  const end = rest.findIndex((line) => !line.startsWith("- "));
  return rest.slice(0, end === -1 ? rest.length : end);
};

test("add_project lists its person, deal, status, dates and notes, and every column shows", async () => {
  const db = await setup("INSERT INTO tasks (id, deal_id, contact_id, title) VALUES ('tk_w1', 'dl_seed07', 'ct_seed07', 'Hang the sign')");
  const answer = await propose(db, [
    { action: "add_project", deal: "dl_seed07", name: "Salon launch", status: "On hold", startAt: "2026-12-01", targetAt: "2027-01-30", notes: "Phase one.", moveOpenTasks: true },
  ]);
  assert.deepEqual(lines(answer.text, "Add"), [
    '- Project "Salon launch": person Alex Sample; from deal "Salon booking site"; status On hold; start Tue Dec 1; target Sat Jan 30; notes Phase one.',
  ]);
  assert.deepEqual(lines(answer.text, "Tasks"), ['- Task "Hang the sign": for "Salon booking site" (Alex Sample) -> project "Salon launch" (Alex Sample)']);
});

test("an added project with no deal, dates or notes shows only what is set", async () => {
  const db = await setup();
  const answer = await propose(db, [{ action: "add_project", contact: "Pat", name: "Fence repair" }]);
  assert.deepEqual(lines(answer.text, "Add"), ['- Project "Fence repair": person Pat Example; status Active; start (none); target (none)']);
});

test("update_project lists each edit with status labels, dates as dates and archived as yes or no", async () => {
  const db = await setup();
  const answer = await propose(db, [
    { action: "update_project", project: "Retrofit", name: "Retrofit phase 2", status: "done", startAt: "2026-12-02", targetAt: "2027-02-01", notes: "Anchors ordered." },
  ]);
  assert.deepEqual(lines(answer.text, "Update"), [
    '- Project "Retrofit" (Pat Example): name Retrofit -> Retrofit phase 2; status Active -> Done; start Tue Dec 1 -> Wed Dec 2; target (none) -> Mon Feb 1; notes (none) -> Anchors ordered.',
  ]);
  const archived = await propose(db, [{ action: "update_project", project: "pj_seed01", archived: true, startAt: null }]);
  assert.deepEqual(lines(archived.text, "Update"), ['- Project "Retrofit" (Pat Example): start Tue Dec 1 -> (none); archived no -> yes']);
});

test("a project named by an earlier add_project ('@n') takes a task, a note, a timer and time", async () => {
  const db = await setup();
  const answer = await propose(db, [
    { action: "add_project", contact: "Pat", name: "Fence repair" },
    { action: "add_task", project: "@1", title: "Order posts" },
    { action: "log_activity", project: "@1", type: "note", summary: "Pat approved the layout." },
    { action: "start_timer", project: "@1", workType: "Design" },
  ]);
  assert.deepEqual(lines(answer.text, "Tasks"), ['- New task "Order posts": for project "Fence repair" (Pat Example); due (none)']);
  assert.deepEqual(lines(answer.text, "Notes"), ['- Note on Pat Example about project "Fence repair": Pat approved the layout.']);
  assert.match(lines(answer.text, "Time")[0] ?? "", /^- Timer started now, Design, .*for project "Fence repair" \(Pat Example\)$/);
});

test("a project by exact name, ignoring case, is used; several or none are questions; ids show only for the owner's own names", async () => {
  const db = await setup(
    "INSERT INTO projects (id, name, contact_id) VALUES ('pj_two', 'RETROFIT', 'ct_seed02'), ('pj_arch', 'Old job', 'ct_seed01'), ('pj_out', 'Pergola', 'ct_seed01'); " +
      "UPDATE projects SET archived = 1 WHERE id = 'pj_arch'; UPDATE projects SET untrusted_fields = '[\"name\"]' WHERE id = 'pj_out'",
  );
  const asked = await proposeChanges(
    ctxFor(db),
    { actions: [{ action: "add_task", project: "retrofit", title: "A" }, { action: "add_task", project: "Old job", title: "B" }, { action: "add_task", project: "Pergola", title: "C" }] },
    DEPS,
  );
  assert.deepEqual(asked, {
    kind: "questions",
    questions: [
      'Which project is "retrofit"? "Retrofit" (pj_seed01) or "RETROFIT" (pj_two). Send the list again with the id.',
      'Which project is "Old job"? No live project matches. Send the list again with the project\'s id.',
      'Which project is "Pergola"? project pj_out. Send the list again with the id.',
    ],
  });
});

test("'@n' names only a project an earlier action adds, and only as the subject of a later record", async () => {
  const db = await setup();
  const refused = (actions: RecordAction[]) => proposeChanges(ctxFor(db), { actions }, DEPS);
  await assert.rejects(refused([{ action: "add_contact", name: "Lee Example" }, { action: "add_task", project: "@1", title: "A" }]), /Action 2 names @1, but action 1 adds no project\./);
  await assert.rejects(refused([{ action: "add_project", contact: "Pat", name: "Fence" }, { action: "update_project", project: "@1", status: "done" }]), /Action 2 changes the project action 1 adds\. Put those details in action 1 instead\./);
  await assert.rejects(refused([{ action: "add_project", contact: "Pat", name: "Fence" }, { action: "update_time_entry", entry: "te_x", project: "@1" }]), /Action 2 changes the project action 1 adds\./);
  await assert.rejects(refused([{ action: "add_lead", name: "Lee Example" }, { action: "add_project", deal: "@1", name: "x" }]), /Action 2 names @1 as its deal/);
});

test("a project for a person an earlier action adds is proposed", async () => {
  const db = await setup();
  const answer = await propose(db, [{ action: "add_contact", name: "Lee Example" }, { action: "add_project", contact: "@1", name: "Lee sign" }]);
  assert.match(lines(answer.text, "Add")[1] ?? "", /^- Project "Lee sign": person Lee Example; status Active/);
});

test("apply reports the deals it marked Won, and none for an ordinary list", async () => {
  const db = await setup();
  const won = await propose(db, [{ action: "update_deal", deal: "dl_seed05", status: "won" }]);
  const applied = await applyChanges(ctxFor(db, "apply_changes"), won.id, DEPS);
  assert.deepEqual(applied.wonDeals, ["dl_seed05"]);
  assert.deepEqual((await applyChanges(ctxFor(db, "apply_changes"), won.id, DEPS)).wonDeals, [], "a second apply asks nothing again");
  const plain = await propose(db, [{ action: "add_task", title: "Buy ink" }]);
  assert.deepEqual((await applyChanges(ctxFor(db, "apply_changes"), plain.id, DEPS)).wonDeals, []);
});
