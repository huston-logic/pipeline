// Capture through the AI app (decision 0048): a ramble becomes one propose_changes call, one apply_changes and, if the
// owner changes their mind, one undo_change. Driven over Streamable HTTP against `wrangler dev --local` and its real
// local D1 database with the demo seed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { addDays, localDate } from "../../src/time.ts";
import { approved, CHANGE_LINE, connectHttp, ok, okText } from "../helpers/mcp-client.ts";
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

type Stored = { id: string; title: string; contactId: string | null; dealId: string | null; dueAt: string | null };
const storedTasks = async (): Promise<Stored[]> => ((await ok(client, "list_tasks", { limit: 100 })).data as { tasks: Stored[] }).tasks;

type Task = { record: string; id: string; fields: { field: string; to: string }[] };
type Proposed = { proposal: string; list: { tasks: Task[] } };

/** A date four days out in the owner's timezone, so the test never depends on the day it runs. */
const fourDaysOut = (): string => addDays(localDate(new Date(), "America/Los_Angeles"), 4);

test("capture: three tasks, one yes, one undo", async () => {
  // Matt is a fake person the test adds; the demo seed's "Dana Whitfield" is the one person a bare "Dana" names.
  const matt = (await approved(client, "add_contact", { name: "Matt Example", email: "matt@example.com" })).data as { contactId: string };
  const search = async (query: string) => ((await ok(client, "search_contacts", { query })).data as { contacts: { id: string }[] }).contacts;
  assert.equal((await search("Dana")).length, 1, "a bare Dana names one person");
  assert.equal((await search("Matt")).length, 1, "a bare Matt names one person");

  const due = fourDaysOut();
  const proposed = await okText(client, "propose_changes", {
    actions: [
      { action: "add_task", contact: "Dana", title: "Call Dana", dueAt: due },
      { action: "add_task", contact: "Matt", title: "Send Matt the deck" },
      { action: "add_task", title: "Buy printer ink" },
    ],
  });
  const { proposal, list } = proposed.data as Proposed;
  assert.equal(list.tasks.length, 3, "three tasks and no question");
  const shown = (title: string) => list.tasks.find((task) => task.record === `New task "${title}"`);
  assert.equal(shown("Call Dana")?.fields.find((f) => f.field === "for")?.to, "Dana Whitfield");
  assert.equal(shown("Send Matt the deck")?.fields.find((f) => f.field === "for")?.to, "Matt Example");
  assert.equal(shown("Buy printer ink")?.fields[0]?.to, "no person or deal");

  const applied = await ok(client, "apply_changes", { proposal });
  assert.match(applied.headline, CHANGE_LINE);
  const { changeId, applied: count } = applied.data as { changeId: string; applied: number };
  assert.equal(count, 3);

  const changes = ((await ok(client, "recent_changes")).data as { changes: { changeId: string }[] }).changes;
  assert.equal(changes[0]?.changeId, changeId, "one change for the three tasks");
  const written = (await storedTasks()).filter((task) => task.id && list.tasks.some((listed) => listed.id === task.id));
  assert.equal(written.length, 3);
  const byTitle = (title: string) => written.find((task) => task.title === title);
  assert.equal(byTitle("Call Dana")?.contactId, "ct_seed01", "Dana's task is on Dana");
  assert.ok(String(byTitle("Call Dana")?.dueAt).startsWith(due), "and due on the date");
  assert.equal(byTitle("Send Matt the deck")?.contactId, matt.contactId, "Matt's task is on Matt");
  const ink = byTitle("Buy printer ink");
  assert.deepEqual([ink?.contactId, ink?.dealId], [null, null], "the ink task belongs to nobody");

  const undone = await ok(client, "undo_change", { changeId });
  assert.match(undone.headline, new RegExp(`^Undid ${changeId}: `));
  const left = (await storedTasks()).filter((task) => list.tasks.some((listed) => listed.id === task.id));
  assert.equal(left.length, 0, "one undo takes the three tasks back");
});
