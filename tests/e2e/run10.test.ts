// Run 10 "Projects, finished": acceptance sentences 39 to 48 (and run 11's 49 and 50, which also need approval on the board) over MCP against the real Worker and the fake seed.
// The seed has projects on, pj_seed01 "Storage building B retrofit" (person ct_seed07, tasks tk_seed16 to tk_seed18) and the
// templates tp_seed01 "Website build" and tp_seed02. The tests run in order and share one database: 47 and 48 come last
// because once approval is on the board the AI app cannot undo or apply anything.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { approved, fails, ok, okText } from "../helpers/mcp-client.ts";
import { connectHttp } from "../helpers/mcp-client.ts";
import { type DevServer, startDevServer } from "./harness.ts";

let server: DevServer;
let client: Client;

before(async () => {
  server = await startDevServer();
  client = await connectHttp(`${server.url}/mcp`);
});

after(async () => {
  await client?.close();
  await server?.stop();
});

type TaskItem = { id: string; title: string; contactId: string | null; dealId: string | null; projectId: string | null; parentId: string | null; depth: number; position: number | null };
type ProjectData = { id: string; contactId: string | null; openTasks: TaskItem[]; doneTasks: TaskItem[] };

const RETROFIT = "Storage building B retrofit";
const tasksOf = async (project: string): Promise<TaskItem[]> => ((await ok(client, "list_tasks", { project })).data as { tasks: TaskItem[] }).tasks;
const titles = (tasks: TaskItem[]): string[] => tasks.map((t) => t.title);
const project = async (id: string): Promise<ProjectData> => (await ok(client, "get_project", { project: id })).data as ProjectData;
const proposeApply = async (actions: Record<string, unknown>[]) => {
  const proposed = await okText(client, "propose_changes", { actions });
  const { proposal } = proposed.data as { proposal: string };
  const applied = await ok(client, "apply_changes", { proposal });
  return { proposed, applied, changeId: (applied.data as { changeId: string }).changeId };
};

let boltTask = "";
let craneTask = "";
let officeMove = "";
let settingsChange = "";

describe("the run 10 sentences", () => {
  test('39. "Add a project status Waiting on client, open, after On hold."', async () => {
    const added = await ok(client, "add_project_status", { label: "Waiting on client", kind: "open", position: 3 });
    assert.match(added.headline, /\(change chg_[a-z0-9]{12}\)$/);
    const { statuses } = (await ok(client, "list_projects")).data as { statuses: { key: string; label: string; kind: string }[] };
    assert.deepEqual(statuses[2], { key: "waiting_on_client", label: "Waiting on client", kind: "open" });
    assert.equal(statuses[1]?.key, "on_hold");
  });

  test('40. "Start an internal project: office move."', async () => {
    const started = await approved(client, "add_project", { name: "Office move" });
    officeMove = (started.data as { projectId?: string }).projectId ?? "";
    assert.match(officeMove, /^pj_/);
    assert.equal((await project(officeMove)).contactId, null);
    const task = await approved(client, "add_task", { project: "Office move", title: "Book the movers" });
    assert.match((task.data as { taskId?: string }).taskId ?? "", /^tk_/);
    const [mine] = await tasksOf("Office move");
    assert.equal(mine?.title, "Book the movers");
    assert.equal(mine?.contactId, null);
    assert.equal(mine?.dealId, null);
    assert.equal(mine?.projectId, officeMove);
  });

  test('41. "Under the retrofit\'s first task, add a sub-task: book the crane."', async () => {
    const first = (await tasksOf(RETROFIT)).find((t) => t.parentId === null && t.title.startsWith("Order the anchor bolts"));
    assert.ok(first, "the retrofit's first task");
    boltTask = first.id;
    const added = await approved(client, "add_task", { parent: boltTask, title: "Book the crane" });
    craneTask = (added.data as { taskId: string }).taskId;
    const crane = (await tasksOf(RETROFIT)).find((t) => t.id === craneTask);
    assert.equal(crane?.parentId, boltTask);
    assert.equal(crane?.depth, 1);
    assert.equal(crane?.projectId, "pj_seed01");
    assert.equal(crane?.dealId, null);
    const detail = await project("pj_seed01");
    assert.equal(detail.openTasks.find((t) => t.id === craneTask)?.depth, 1);
  });

  test('42. "Mark that task done and its sub-tasks too."', async () => {
    const question = await fails(client, "complete_task", { task: boltTask });
    assert.match(question, /sub-task/);
    assert.match(question, /complete/);
    const stillOpen = (await project("pj_seed01")).openTasks.map((t) => t.id);
    assert.ok(stillOpen.includes(boltTask) && stillOpen.includes(craneTask), "the refusal writes nothing");

    const done = await approved(client, "complete_task", { task: boltTask, subTasks: "complete" });
    const { changeId } = done.data as { changeId: string };
    const after = await project("pj_seed01");
    assert.ok(!after.openTasks.some((t) => t.id === boltTask || t.id === craneTask));
    const doneIds = after.doneTasks.map((t) => t.id);
    assert.ok(doneIds.includes(boltTask) && doneIds.includes(craneTask), "both are done");

    await ok(client, "undo_change", { changeId });
    const undone = (await project("pj_seed01")).openTasks.map((t) => t.id);
    assert.ok(undone.includes(boltTask) && undone.includes(craneTask), "undo reopens both");
  });

  test('43. "Plan the Harbor kitchen job: a new project starting Monday with demolition (two sub-tasks), cabinets and paint."', async () => {
    const { proposed, applied, changeId } = await (async () => {
      const result = await proposeApply([
        { action: "add_project", contact: "Dana Whitfield", name: "Harbor kitchen", startAt: "2026-12-07" },
        {
          action: "add_task_plan",
          project: "@1",
          tasks: [
            { title: "Demolition", dueDays: 0 },
            { title: "Remove the old cabinets", under: 1, dueDays: 1 },
            { title: "Haul away the debris", under: 1, dueDays: 2 },
            { title: "Install cabinets", dueDays: 7 },
            { title: "Paint", dueDays: 14 },
          ],
        },
      ]);
      return result;
    })();
    const lines = (proposed.data as { list: { tasks: { lines: string[] }[] } }).list.tasks[0]?.lines ?? [];
    const indent = (title: string) => (lines.find((l) => l.includes(`"${title}"`)) ?? "").search(/\S/);
    assert.ok(indent("Remove the old cabinets") > indent("Demolition"), "sub-tasks are indented under their task");
    assert.equal(indent("Haul away the debris"), indent("Remove the old cabinets"));
    assert.equal(indent("Install cabinets"), indent("Demolition"));
    assert.match(changeId, /^chg_[a-z0-9]{12}$/);
    assert.match(applied.headline, /\(change chg_[a-z0-9]{12}\)$/);

    const listed = (await ok(client, "list_projects")).data as { items: { id: string; name: string }[] };
    const harbor = listed.items.find((p) => p.name === "Harbor kitchen");
    assert.ok(harbor);
    const tasks = await tasksOf("Harbor kitchen");
    assert.deepEqual(titles(tasks).sort(), ["Demolition", "Haul away the debris", "Install cabinets", "Paint", "Remove the old cabinets"]);
    assert.equal(tasks.filter((t) => t.depth === 1).length, 2);

    await ok(client, "undo_change", { changeId });
    const after = (await ok(client, "list_projects")).data as { items: { name: string }[] };
    assert.ok(!after.items.some((p) => p.name === "Harbor kitchen"), "undo removes the project");
    await fails(client, "get_project", { project: harbor.id });
  });

  test('44. "Add three more tasks to the retrofit project."', async () => {
    const before = await tasksOf(RETROFIT);
    const top = Math.max(...before.filter((t) => t.parentId === null).map((t) => t.position ?? 0));
    await proposeApply([{ action: "add_task_plan", project: RETROFIT, tasks: [{ title: "Pour the footings" }, { title: "Frame the walls" }, { title: "Final inspection" }] }]);
    const after = await tasksOf(RETROFIT);
    assert.equal(after.length, before.length + 3);
    const added = ["Pour the footings", "Frame the walls", "Final inspection"].map((title) => after.find((t) => t.title === title));
    const positions = added.map((t) => t?.position ?? 0);
    assert.ok(positions.every((p) => p > top), `after the existing tasks: ${positions.join(",")} > ${top}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "in the order given");
  });

  test('45. "Start a project for Dana from the Website build template."', async () => {
    const started = await approved(client, "add_project", { contact: "Dana Whitfield", name: "Whitfield website", template: "Website build", startAt: "2026-12-07" });
    const projectId = (started.data as { projectId: string }).projectId;
    const copied = await tasksOf("Whitfield website");
    assert.deepEqual(titles(copied).sort(), ["Build and test", "Design the pages", "Home page mockup", "Kickoff call", "Launch"]);
    assert.equal(copied.find((t) => t.title === "Home page mockup")?.depth, 1);
    assert.equal(copied.every((t) => t.projectId === projectId && t.contactId === "ct_seed01"), true);

    await approved(client, "update_template", { template: "Website build", tasks: [{ title: "A shorter plan" }] });
    assert.equal((await tasksOf("Whitfield website")).length, 5, "editing the template leaves the project alone");
  });

  test('46. "Save the retrofit project\'s tasks as a template called Retrofit job."', async () => {
    await approved(client, "save_project_as_template", { project: RETROFIT, name: "Retrofit job" });
    const view = (await ok(client, "get_template", { template: "Retrofit job" })).data as { name: string; tasks: { title: string; depth: number }[] };
    assert.equal(view.name, "Retrofit job");
    const byTitle = new Map(view.tasks.map((t) => [t.title, t.depth]));
    assert.equal(byTitle.get("Book the crane"), 1);
    assert.equal(byTitle.get("Order the anchor bolts for building B"), 0);
    assert.ok(byTitle.has("Final inspection"));
  });

  test('47. "From now on, approve AI changes on the board only."', async () => {
    const set = await ok(client, "update_settings", { approveIn: "board" });
    settingsChange = (set.data as { changeId: string }).changeId;
    assert.match(settingsChange, /^chg_/);
    assert.equal(((await ok(client, "get_settings")).data as { approveIn: string }).approveIn, "board");

    const proposed = await okText(client, "add_task", { project: "Office move", title: "Hire a van" });
    const { proposal } = proposed.data as { proposal: string };
    assert.match(await fails(client, "apply_changes", { proposal }), /\/pending/);
    assert.ok(!titles(await tasksOf("Office move")).includes("Hire a van"), "nothing was written");
    assert.match(await fails(client, "update_settings", { approveIn: "chat" }), /Only the board can switch this back/);
  });

  test('48. "Undo that."', async () => {
    assert.match(await fails(client, "undo_change", { changeId: settingsChange }), /\/changes/);
    assert.equal(((await ok(client, "get_settings")).data as { approveIn: string }).approveIn, "board");
  });
  test('49. "Pause the quiet-deals rule." (approval on the board only)', async () => {
    const before = ((await ok(client, "list_rules")).data as { rules: { id: string; active: boolean }[] }).rules.find((rule) => rule.id === "ru_seed01");
    assert.equal(before?.active, true);
    const proposed = await okText(client, "pause_rule", { rule: "ru_seed01" });
    assert.match(proposed.headline, /Approve on the board: .*\/pending\./);
    assert.match(proposed.headline, /Rule ru_seed01: paused: /);
    const after = ((await ok(client, "list_rules")).data as { rules: { id: string; active: boolean }[] }).rules.find((rule) => rule.id === "ru_seed01");
    assert.equal(after?.active, true, "nothing was written");
    const { proposal } = proposed.data as { proposal: string };
    assert.match(await fails(client, "apply_changes", { proposal }), /\/pending/);
  });

  test('50. "Log that I called Pat." (approval on the board only)', async () => {
    const proposed = await okText(client, "log_activity", { deal: "dl_seed01", type: "call", summary: "Rang Pat about the quote" });
    assert.match(proposed.headline, /Approve on the board: .*\/pending\./);
  });
});
