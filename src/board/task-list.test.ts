// Today's task list (decision 0047): the sort and filter from the address, and the two lists, which the database sorts
// and cuts (openTaskLists, run 6 final review). Fake tasks on an empty copy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { openTaskLists, type OpenTask, type TaskView } from "../services/read.ts";
import { taskView } from "./task-list.ts";

const NOW = new Date("2026-11-20T18:00:00.000Z");

type Fake = { id: string; dueAt?: string; createdAt?: string; deal?: string; contact?: string };

/** An empty copy with Ann (two of them, one in lower case), Zed, and Ann's deal, and these tasks. */
async function listsOf(tasks: Fake[], view: TaskView, limit = 50) {
  const db = await createTestDb();
  db.exec(
    "INSERT INTO contacts (id, name) VALUES ('ct_1', 'Ann Example'), ('ct_2', 'Zed Example'), ('ct_3', 'ann Example'); " +
      "INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ('dl_1', 'ct_3', 'Ann''s site', 'new_inquiry', '2026-11-01T00:00:00.000Z')",
  );
  for (const task of tasks) {
    db.prepare("INSERT INTO tasks (id, deal_id, contact_id, title, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(task.id, task.deal ?? null, task.contact ?? null, `Task ${task.id}`, task.dueAt ?? null, task.createdAt ?? "2026-11-01T10:00:00.000Z", "2026-11-01T10:00:00.000Z")
      .run();
  }
  return openTaskLists(db, NOW, DEFAULT_TZ, view, limit);
}

const ids = (tasks: OpenTask[]) => tasks.map((t) => t.id);
const due = { sort: "due", show: "all" } as const;

test("overdue first then soonest", async () => {
  const { todo } = await listsOf(
    [
      { id: "later", dueAt: "2026-11-30T17:00:00.000Z" },
      { id: "overdue", dueAt: "2026-11-10T17:00:00.000Z" },
      { id: "soon", dueAt: "2026-11-24T17:00:00.000Z" },
    ],
    due,
  );
  assert.deepEqual(ids(todo), ["overdue", "soon", "later"]);
});

test("undated tasks go to Needs a due date", async () => {
  const lists = await listsOf([{ id: "a", dueAt: "2026-11-24T17:00:00.000Z" }, { id: "b" }, { id: "c" }], due);
  assert.deepEqual(ids(lists.todo), ["a"]);
  assert.deepEqual(ids(lists.undated), ["b", "c"]);
  assert.deepEqual(lists.totals, { todo: 1, undated: 2 });
});

test("newest sort", async () => {
  const { todo, undated } = await listsOf(
    [
      { id: "old", dueAt: "2026-11-24T17:00:00.000Z", createdAt: "2026-11-01T10:00:00.000Z" },
      { id: "new", dueAt: "2026-11-30T17:00:00.000Z", createdAt: "2026-11-20T10:00:00.000Z" },
      { id: "n1", createdAt: "2026-11-02T10:00:00.000Z" },
      { id: "n2", createdAt: "2026-11-05T10:00:00.000Z" },
    ],
    { sort: "newest", show: "all" },
  );
  assert.deepEqual(ids(todo), ["new", "old"]);
  assert.deepEqual(ids(undated), ["n2", "n1"]);
});

test("subject sort puts standalone last", async () => {
  const { todo } = await listsOf(
    [
      { id: "alone", dueAt: "2026-11-01T17:00:00.000Z" },
      { id: "zed", dueAt: "2026-11-02T17:00:00.000Z", contact: "ct_2" },
      // On a deal: the deal's person, whose name differs from the other Ann's only in case.
      { id: "ann-late", dueAt: "2026-11-09T17:00:00.000Z", deal: "dl_1", contact: "ct_3" },
      { id: "ann-early", dueAt: "2026-11-03T17:00:00.000Z", contact: "ct_1" },
    ],
    { sort: "subject", show: "all" },
  );
  assert.deepEqual(ids(todo), ["ann-early", "ann-late", "zed", "alone"]);
});

test("linked and standalone filters", async () => {
  const tasks: Fake[] = [{ id: "alone" }, { id: "on-deal", deal: "dl_1", contact: "ct_3" }, { id: "on-person", contact: "ct_1" }];
  assert.deepEqual(ids((await listsOf(tasks, { sort: "due", show: "linked" })).undated), ["on-deal", "on-person"]);
  assert.deepEqual(ids((await listsOf(tasks, { sort: "due", show: "standalone" })).undated), ["alone"]);
  assert.deepEqual(ids((await listsOf(tasks, { sort: "due", show: "all" })).undated), ["alone", "on-deal", "on-person"]);
});

test("each list is cut after the sort, and its total counts them all", async () => {
  const tasks: Fake[] = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, dueAt: `2026-12-0${7 - i}T17:00:00.000Z` }));
  const lists = await listsOf([...tasks, { id: "u1" }, { id: "u2" }, { id: "u3" }], due, 3);
  assert.deepEqual(ids(lists.todo), ["t6", "t5", "t4"], "the soonest three");
  assert.deepEqual(ids(lists.undated), ["u1", "u2", "u3"]);
  assert.deepEqual(lists.totals, { todo: 7, undated: 3 });
});

test("unknown sort falls back", () => {
  assert.deepEqual(taskView(new URLSearchParams("sort=oldest&show=everything")), due);
  assert.deepEqual(taskView(new URLSearchParams("")), due);
  assert.deepEqual(taskView(new URLSearchParams("sort=subject&show=standalone")), { sort: "subject", show: "standalone" });
  assert.deepEqual(taskView(new URLSearchParams("sort=newest&show=linked")), { sort: "newest", show: "linked" });
});
