// Proposals end to end (decision 0044): propose_changes, apply_changes and undo_change over Streamable HTTP against
// `wrangler dev --local` and its real local D1 database with the demo seed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { CHANGE_LINE, connectHttp, ok, okText } from "../helpers/mcp-client.ts";
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

/** The demo deal's open tasks, as get_deal lists them. */
const openTasks = async () => ((await ok(client, "get_deal", { deal: "dl_seed01" })).data as { openTasks: { id: string }[] }).openTasks;

test("tools/list includes propose_changes and apply_changes", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("propose_changes"));
  assert.ok(names.includes("apply_changes"));
});

test("three tasks proposed, applied as one change, and one undo takes all three back", async () => {
  const before = (await openTasks()).length;
  const proposed = await okText(client, "propose_changes", {
    actions: [1, 2, 3].map((n) => ({ action: "add_task", deal: "dl_seed01", title: `Proposal task ${n}`, dueAt: `2030-01-0${n}` })),
  });
  const { proposal, list } = proposed.data as { proposal: string; list: { tasks: { id: string }[] } };
  assert.equal(list.tasks.length, 3);
  assert.match(proposed.headline, new RegExp(`^Proposal ${proposal} \\(expires [0-9:]+ [AP]M\\)\\. Nothing has changed yet\\.`));
  assert.equal((await openTasks()).length, before, "proposing writes no task");

  const applied = await ok(client, "apply_changes", { proposal });
  assert.match(applied.headline, CHANGE_LINE);
  const { changeId, applied: count } = applied.data as { changeId: string; applied: number };
  assert.equal(count, 3);
  const added = (await openTasks()).map((task) => task.id).filter((id) => list.tasks.some((task) => task.id === id));
  assert.equal(added.length, 3, "the tasks have the ids the list showed");

  const undone = await ok(client, "undo_change", { changeId });
  assert.match(undone.headline, new RegExp(`^Undid ${changeId}: Removed `));
  assert.equal((await openTasks()).length, before, "the undo restores the task count");
});
