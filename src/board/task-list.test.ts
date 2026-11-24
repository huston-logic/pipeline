// Today's task list (decision 0047): the sort and filter from the address, and the two lists. Pure, fake tasks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { arrangeTasks, type ListedTask, taskView } from "./task-list.ts";

const task = (id: string, extra: Partial<ListedTask> = {}): ListedTask => ({
  id,
  dueAt: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  dealId: null,
  contactId: null,
  contactName: null,
  ...extra,
});

const ids = (tasks: ListedTask[]) => tasks.map((t) => t.id);
const due = { sort: "due", show: "all" } as const;

test("overdue first then soonest", () => {
  const { todo } = arrangeTasks(
    [
      task("later", { dueAt: "2026-11-30T17:00:00.000Z" }),
      task("overdue", { dueAt: "2026-11-10T17:00:00.000Z" }),
      task("soon", { dueAt: "2026-11-24T17:00:00.000Z" }),
    ],
    due,
  );
  assert.deepEqual(ids(todo), ["overdue", "soon", "later"]);
});

test("undated tasks go to Needs a due date", () => {
  const lists = arrangeTasks([task("a", { dueAt: "2026-11-24T17:00:00.000Z" }), task("b"), task("c")], due);
  assert.deepEqual(ids(lists.todo), ["a"]);
  assert.deepEqual(ids(lists.undated), ["b", "c"]);
});

test("newest sort", () => {
  const { todo, undated } = arrangeTasks(
    [
      task("old", { dueAt: "2026-11-24T17:00:00.000Z", createdAt: "2026-11-01T10:00:00.000Z" }),
      task("new", { dueAt: "2026-11-30T17:00:00.000Z", createdAt: "2026-11-20T10:00:00.000Z" }),
      task("n1", { createdAt: "2026-11-02T10:00:00.000Z" }),
      task("n2", { createdAt: "2026-11-05T10:00:00.000Z" }),
    ],
    { sort: "newest", show: "all" },
  );
  assert.deepEqual(ids(todo), ["new", "old"]);
  assert.deepEqual(ids(undated), ["n2", "n1"]);
});

test("subject sort puts standalone last", () => {
  const { todo } = arrangeTasks(
    [
      task("alone", { dueAt: "2026-11-01T17:00:00.000Z" }),
      task("zed", { dueAt: "2026-11-02T17:00:00.000Z", contactId: "ct_2", contactName: "Zed Example" }),
      task("ann-late", { dueAt: "2026-11-09T17:00:00.000Z", dealId: "dl_1", contactId: "ct_1", contactName: "ann Example" }),
      task("ann-early", { dueAt: "2026-11-03T17:00:00.000Z", contactId: "ct_1", contactName: "Ann Example" }),
    ],
    { sort: "subject", show: "all" },
  );
  assert.deepEqual(ids(todo), ["ann-early", "ann-late", "zed", "alone"]);
});

test("linked and standalone filters", () => {
  const tasks = [task("alone"), task("on-deal", { dealId: "dl_1", contactId: "ct_1", contactName: "Ann" }), task("on-person", { contactId: "ct_1", contactName: "Ann" })];
  assert.deepEqual(ids(arrangeTasks(tasks, { sort: "due", show: "linked" }).undated), ["on-deal", "on-person"]);
  assert.deepEqual(ids(arrangeTasks(tasks, { sort: "due", show: "standalone" }).undated), ["alone"]);
  assert.deepEqual(ids(arrangeTasks(tasks, { sort: "due", show: "all" }).undated), ["alone", "on-deal", "on-person"]);
});

test("unknown sort falls back", () => {
  assert.deepEqual(taskView(new URLSearchParams("sort=oldest&show=everything")), due);
  assert.deepEqual(taskView(new URLSearchParams("")), due);
  assert.deepEqual(taskView(new URLSearchParams("sort=subject&show=standalone")), { sort: "subject", show: "standalone" });
  assert.deepEqual(taskView(new URLSearchParams("sort=newest&show=linked")), { sort: "newest", show: "linked" });
});
