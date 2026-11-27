// Today's rows (run 12, ruling 9): the open to-dos, one row per project and the deals due, grouped by when. Fake people
// and tasks on an empty copy; "now" is 10:00 on Fri Nov 20 in Los Angeles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countingDb } from "../../tests/helpers/counting-db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { PROJECT_TASK_LIMIT, type TodayItem, todayRows, type TodayView } from "./today.ts";

const NOW = new Date("2026-11-20T18:00:00.000Z");
const YESTERDAY = "2026-11-19T17:00:00.000Z";
const EARLIER = "2026-11-10T17:00:00.000Z";
const TODAY = "2026-11-20T23:00:00.000Z";
const LATER = "2026-11-25T17:00:00.000Z";
const due: TodayView = { sort: "due", show: "all" };

type Fake = {
  id: string;
  title?: string;
  dueAt?: string;
  doneAt?: string;
  snoozed?: string;
  project?: string;
  parent?: string;
  position?: number;
  deal?: string;
  contact?: string;
  createdAt?: string;
};

async function seeded(tasks: Fake[] = []) {
  const db = await createTestDb();
  db.exec(
    "UPDATE settings SET projects = 1; " +
      "INSERT INTO contacts (id, name) VALUES ('ct_1', 'Ann Example'), ('ct_2', 'Zed Example'); " +
      "INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ('dl_1', 'ct_1', 'Ann site', 'new_inquiry', '2026-11-01T00:00:00.000Z'); " +
      "INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES " +
      "('pj_1', 'Retrofit', 'ct_2', 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), " +
      "('pj_2', 'Garden', NULL, 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
  );
  for (const t of tasks) {
    db.prepare(
      "INSERT INTO tasks (id, project_id, parent_id, position, deal_id, contact_id, title, due_at, done_at, snoozed_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        t.id,
        t.project ?? null,
        t.parent ?? null,
        t.project === undefined ? null : (t.position ?? 1),
        t.deal ?? null,
        t.contact ?? null,
        t.title ?? `Task ${t.id}`,
        t.dueAt ?? null,
        t.doneAt ?? null,
        t.snoozed ?? null,
        t.createdAt ?? "2026-11-01T10:00:00.000Z",
        "2026-11-01T10:00:00.000Z",
      )
      .run();
  }
  return db;
}

const keyOf = (item: TodayItem): string => (item.kind === "task" ? item.task.id : item.kind === "project" ? item.project.id : item.deal.id);
const keys = (items: TodayItem[]) => items.map(keyOf);

test("groups: Overdue, Today, Upcoming and No due date, by the owner's day", async () => {
  const db = await seeded([
    { id: "late", dueAt: YESTERDAY },
    { id: "now", dueAt: TODAY },
    { id: "soon", dueAt: LATER },
    { id: "whenever" },
  ]);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["late"]);
  assert.deepEqual(keys(groups.today), ["now"]);
  assert.deepEqual(keys(groups.upcoming), ["soon"]);
  assert.deepEqual(keys(groups.undated), ["whenever"]);
});

test("a snoozed or done task is not a row", async () => {
  const db = await seeded([
    { id: "asleep", dueAt: YESTERDAY, snoozed: "2026-11-22T17:00:00.000Z" },
    { id: "done", dueAt: YESTERDAY, doneAt: "2026-11-19T18:00:00.000Z" },
    { id: "awake", dueAt: YESTERDAY, snoozed: "2026-11-19T17:00:00.000Z" },
  ]);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["awake"]);
});

test("one row per project: N top-level tasks open or with open sub-tasks, M overdue at any depth, the soonest due", async () => {
  const db = await seeded([
    { id: "a", project: "pj_1", position: 1, dueAt: LATER },
    { id: "b", project: "pj_1", position: 2, doneAt: "2026-11-18T18:00:00.000Z" },
    { id: "b1", project: "pj_1", parent: "b", position: 1, dueAt: EARLIER },
    { id: "c", project: "pj_1", position: 3, doneAt: "2026-11-18T18:00:00.000Z" },
    { id: "d", project: "pj_1", position: 4 },
    { id: "d1", project: "pj_1", parent: "d", position: 1, dueAt: YESTERDAY },
  ]);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  const all = [...groups.overdue, ...groups.today, ...groups.upcoming, ...groups.undated];
  assert.deepEqual(keys(all), ["pj_1"], "the project's tasks are not rows of their own");
  assert.deepEqual(keys(groups.overdue), ["pj_1"], "the row sits in the group of its soonest due");
  const row = groups.overdue[0];
  assert.ok(row?.kind === "project");
  const { project } = row;
  assert.equal(project.name, "Retrofit");
  assert.equal(project.topLevel, 3, "a, d, and b (done, with an open sub-task); c is done with nothing open");
  assert.equal(project.overdue, 2, "b1 and d1");
  assert.equal(project.soonest, EARLIER);
  assert.deepEqual(project.tasks.map((t) => t.id), ["a", "b", "d"], "top-level tasks in position order");
  assert.deepEqual(project.tasks[2]?.children.map((t) => t.id), ["d1"]);
});

test("a project with no dated task is in No due date; one with only snoozed tasks has no row", async () => {
  const db = await seeded([
    { id: "a", project: "pj_1" },
    { id: "z", project: "pj_2", snoozed: "2026-11-22T17:00:00.000Z" },
  ]);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.undated), ["pj_1"]);
  assert.equal(groups.overdue.length + groups.today.length + groups.upcoming.length, 0);
});

test("deals whose next step is due today or overdue are rows; later ones are not", async () => {
  const db = await seeded();
  db.exec(
    "INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at, next_step, next_at) VALUES " +
      `('dl_late', 'ct_1', 'Late deal', 'new_inquiry', '2026-11-01T00:00:00.000Z', 'Send quote', '${YESTERDAY}'), ` +
      `('dl_now', 'ct_2', 'Today deal', 'new_inquiry', '2026-11-01T00:00:00.000Z', 'Call', '${TODAY}'), ` +
      `('dl_far', 'ct_2', 'Far deal', 'new_inquiry', '2026-11-01T00:00:00.000Z', 'Wait', '${LATER}')`,
  );
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["dl_late"]);
  assert.deepEqual(keys(groups.today), ["dl_now"]);
  assert.equal(groups.upcoming.length, 0);
  const item = groups.overdue[0];
  assert.ok(item?.kind === "deal");
  assert.equal(item.deal.nextStep, "Send quote");
});

test("sort orders rows inside each group", async () => {
  const tasks: Fake[] = [
    { id: "b", title: "Bravo", dueAt: "2026-11-24T17:00:00.000Z", createdAt: "2026-11-02T10:00:00.000Z", contact: "ct_2" },
    { id: "a", title: "Alpha", dueAt: "2026-11-26T17:00:00.000Z", createdAt: "2026-11-05T10:00:00.000Z", contact: "ct_1" },
    { id: "c", title: "Charlie", dueAt: "2026-11-22T17:00:00.000Z", createdAt: "2026-11-03T10:00:00.000Z" },
  ];
  const db = await seeded(tasks);
  assert.deepEqual(keys((await todayRows(db, NOW, DEFAULT_TZ, due)).upcoming), ["c", "b", "a"]);
  assert.deepEqual(keys((await todayRows(db, NOW, DEFAULT_TZ, { sort: "newest", show: "all" })).upcoming), ["a", "c", "b"]);
  assert.deepEqual(keys((await todayRows(db, NOW, DEFAULT_TZ, { sort: "subject", show: "all" })).upcoming), ["a", "b", "c"], "by person, none last");
});

test("show: linked keeps people, deals and projects; standalone only tasks of no one", async () => {
  const db = await seeded([
    { id: "alone" },
    { id: "person", contact: "ct_1" },
    { id: "pt", project: "pj_2" },
  ]);
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at, next_at) VALUES ('dl_x', 'ct_1', 'X', 'new_inquiry', '2026-11-01T00:00:00.000Z', '${YESTERDAY}')`);
  const of = async (show: TodayView["show"]) => {
    const g = await todayRows(db, NOW, DEFAULT_TZ, { sort: "due", show });
    return keys([...g.overdue, ...g.today, ...g.upcoming, ...g.undated]).sort();
  };
  assert.deepEqual(await of("all"), ["alone", "dl_x", "person", "pj_2"]);
  assert.deepEqual(await of("linked"), ["dl_x", "person", "pj_2"]);
  assert.deepEqual(await of("standalone"), ["alone"]);
});

test("with projects off a task that is on a project is an ordinary task row", async () => {
  const db = await seeded([{ id: "pt", project: "pj_1", dueAt: YESTERDAY }]);
  db.exec("UPDATE settings SET projects = 0");
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["pt"]);
});

test("at most 200 task rows are read, and the cut is said", async () => {
  const db = await seeded();
  const values = Array.from({ length: 230 }, (_, i) => `('tk_${i}', 'Task ${i}', '2031-01-01T17:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (id, title, due_at, created_at, updated_at) VALUES ${values.join(",")}`);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.equal(groups.upcoming.length, 200);
  assert.deepEqual(groups.cut, { shown: 200, total: 230 });
  assert.equal((await todayRows(await seeded([{ id: "x" }]), NOW, DEFAULT_TZ, due)).cut, null);
});

test("at most 200 rows in all: the dated first, the undated fill the rest, and the cut says so", async () => {
  const db = await seeded([{ id: "overdue", dueAt: EARLIER }]);
  const many = (from: number, count: number, due: string) =>
    Array.from({ length: count }, (_, i) => `('tk_${from + i}', 'Task ${from + i}', ${due}, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (id, title, due_at, created_at, updated_at) VALUES ${[...many(0, 100, "'2031-01-01T17:00:00.000Z'"), ...many(100, 150, "NULL")].join(",")}`);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["overdue"]);
  assert.equal(groups.upcoming.length, 100);
  assert.equal(groups.undated.length, 99, "200 less the 101 dated");
  assert.deepEqual(groups.cut, { shown: 200, total: 251 });
});

test("a project counts only tasks that are open and awake, or have one below them", async () => {
  const db = await seeded([
    { id: "a", project: "pj_1", position: 1 },
    { id: "asleep", project: "pj_1", position: 2, snoozed: "2026-11-22T17:00:00.000Z" },
    { id: "asleep-kid", project: "pj_1", parent: "asleep", position: 1, snoozed: "2026-11-22T17:00:00.000Z" },
    { id: "done-top", project: "pj_1", position: 3, doneAt: "2026-11-18T18:00:00.000Z" },
    { id: "live-kid", project: "pj_1", parent: "done-top", position: 1 },
  ]);
  const row = (await todayRows(db, NOW, DEFAULT_TZ, due)).undated[0];
  assert.ok(row?.kind === "project");
  assert.equal(row.project.topLevel, 2, "a, and done-top for its awake sub-task; asleep has nothing awake");
  assert.deepEqual(row.project.tasks.map((t) => t.id), ["a", "done-top"]);
  assert.equal(row.project.truncated, false);
});

test("a minute either side of the owner's midnight: overdue, today, upcoming", async () => {
  // Nov 20 in Los Angeles runs from 08:00 UTC on the 20th to 08:00 UTC on the 21st.
  const db = await seeded([
    { id: "before-start", dueAt: "2026-11-20T07:59:00.000Z" },
    { id: "after-start", dueAt: "2026-11-20T08:01:00.000Z" },
    { id: "before-end", dueAt: "2026-11-21T07:59:00.000Z" },
    { id: "after-end", dueAt: "2026-11-21T08:01:00.000Z" },
  ]);
  const groups = await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.deepEqual(keys(groups.overdue), ["before-start"]);
  assert.deepEqual(keys(groups.today), ["after-start", "before-end"]);
  assert.deepEqual(keys(groups.upcoming), ["after-end"]);
});

test("a project's tasks read is cut at 500 and its rows say so", async () => {
  const db = await seeded();
  const values = Array.from({ length: 520 }, (_, i) => `('tk_p${i}', 'pj_1', ${i + 1}, 'Task ${i}', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (id, project_id, position, title, created_at, updated_at) VALUES ${values.join(",")}`);
  const row = (await todayRows(db, NOW, DEFAULT_TZ, due)).undated[0];
  assert.ok(row?.kind === "project");
  assert.equal(row.project.truncated, true);
  assert.equal(row.project.topLevel, PROJECT_TASK_LIMIT);
});

test("one D1 call reads everything", async () => {
  const db = countingDb(await seeded([{ id: "a", dueAt: YESTERDAY }, { id: "b", project: "pj_1" }]));
  await todayRows(db, NOW, DEFAULT_TZ, due);
  assert.equal(db.calls, 1, db.log.join("\n"));
});
