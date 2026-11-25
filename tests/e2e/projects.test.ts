// Projects end to end (decision 0055): acceptance sentences 35 to 38 over MCP against the real Worker and the fake seed.
// The seed has projects on with pj_seed01 "Storage building B retrofit" (from won deal dl_seed07, person ct_seed07) and
// pj_seed02 (On hold); sentence 35 turns projects off first, so it also leaves them on for the rest.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { approved, call, connectHttp, fails, ok, okText } from "../helpers/mcp-client.ts";
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

type Totals = { minutes: number; billableMinutes: number; amountCents: number };
type ProjectDetail = {
  id: string;
  name: string;
  contactId: string;
  dealId: string | null;
  openTaskCount: number;
  time: Totals;
  tasks?: { id: string; title: string }[];
};
type TaskItem = { id: string; title: string; dealId: string | null; contactId: string | null; projectId: string | null };

const OPEN_DEAL = "dl_seed04";
let startedProject = "";

describe("the project sentences", () => {
  test('35. "Turn on projects."', async () => {
    const off = await ok(client, "update_settings", { projects: false });
    assert.match(off.headline, /\(change chg_[a-z0-9]{12}\)$/);
    assert.match(await fails(client, "list_projects"), /^Projects are off\./);
    assert.match(await fails(client, "get_project", { project: "pj_seed01" }), /^Projects are off\./);

    const on = await ok(client, "update_settings", { projects: true });
    assert.match((on.data as { changeId: string }).changeId, /^chg_[a-z0-9]{12}$/);
    const listed = await ok(client, "list_projects");
    assert.doesNotMatch(listed.text, /Projects are off/);
    const ids = (listed.data as { items: { id: string }[] }).items.map((item) => item.id);
    assert.ok(ids.includes("pj_seed01"));
  });

  test('36. "Mark the tank foundations deal won." then "Yes, start a project."', async () => {
    type Brief = { deal: { status: string; title: string; value: number | null; stageKey: string } };
    const before = ((await ok(client, "get_deal", { deal: OPEN_DEAL })).data as Brief).deal;
    assert.equal(before.status, "open");
    const proposed = await okText(client, "update_deal", { deal: OPEN_DEAL, status: "won" });
    const { proposal } = proposed.data as { proposal: string };
    const won = await okText(client, "apply_changes", { proposal });
    assert.match(won.headline, /Ask the owner: start a project for/);
    assert.deepEqual((won.data as { startProject: unknown }).startProject, { deal: OPEN_DEAL });

    const wonDeal = ((await ok(client, "get_deal", { deal: OPEN_DEAL })).data as Brief).deal;
    assert.equal(wonDeal.status, "won");
    const started = await approved(client, "add_project", { deal: OPEN_DEAL, moveOpenTasks: true });
    assert.match(started.proposed.text, /Foundations for three new fermentation tanks/);
    assert.match(started.proposed.text, /Write the tank foundation proposal/);
    assert.match(started.proposed.text, /for /, "each moved task shows its for line");
    startedProject = (started.data as { projectId?: string }).projectId ?? "";
    assert.match(startedProject, /^pj_/);

    const got = (await ok(client, "get_project", { project: startedProject })).data as ProjectDetail;
    assert.equal(got.contactId, "ct_seed04");
    assert.equal(got.dealId, OPEN_DEAL);
    assert.equal(got.openTaskCount, 1);

    const moved = (await ok(client, "list_tasks", { project: startedProject })).data as { tasks: TaskItem[] };
    assert.deepEqual(moved.tasks.map((t) => t.title), ["Write the tank foundation proposal"]);
    assert.equal(moved.tasks[0]?.dealId, null);
    assert.equal(moved.tasks[0]?.contactId, "ct_seed04");

    const deal = ((await ok(client, "get_deal", { deal: OPEN_DEAL })).data as Brief).deal;
    assert.deepEqual(deal, wonDeal, "starting the project leaves the won deal as it was");
  });

  test('37. "Add a task to the retrofit project: order anchors, due Friday."', async () => {
    const dueAt = "2026-12-04T17:00:00.000Z";
    const added = await approved(client, "add_task", { project: "Storage building B retrofit", title: "Order anchors", dueAt });
    assert.match(added.proposed.text, /Storage building B retrofit/);
    const { tasks } = (await ok(client, "list_tasks", { project: "Storage building B retrofit" })).data as { tasks: TaskItem[] };
    const mine = tasks.find((t) => t.title === "Order anchors");
    assert.ok(mine, "the new task is listed");
    assert.equal(mine.projectId, "pj_seed01");
    assert.equal(mine.contactId, "ct_seed07");
    assert.equal(mine.dealId, null);
  });

  test('38. "How much time is on the retrofit project?"', async () => {
    const before = (await ok(client, "get_project", { project: "pj_seed01" })).data as ProjectDetail;
    assert.ok(before.time.minutes > 0 && before.time.billableMinutes > 0 && before.time.amountCents > 0, JSON.stringify(before.time));
    assert.ok(before.time.billableMinutes < before.time.minutes, "the seed has a non-billable entry too");

    const added = await call(client, "add_time_entry", { project: "pj_seed01", startedAt: "2026-11-20T09:00", minutes: 60, workType: "wt_seed01", billable: true });
    assert.equal(added.isError, false, added.text);
    const { proposal } = added.data as { proposal: string };
    await ok(client, "apply_changes", { proposal });

    const after = (await ok(client, "get_project", { project: "pj_seed01" })).data as ProjectDetail;
    assert.equal(after.time.minutes, before.time.minutes + 60);
    assert.equal(after.time.billableMinutes, before.time.billableMinutes + 60);
    assert.equal(after.time.amountCents, before.time.amountCents + 9500);
  });
});
