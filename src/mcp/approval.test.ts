import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { updateSettings } from "../services/settings.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ORIGIN = "https://pipeline.example.com";

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, origin: ORIGIN }));
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
  return { db, c, count };
}

test("approveIn board works over MCP, shows in get_settings, and chat is refused while it is board", async () => {
  const { c } = await setup();
  const approveIn = async () => ((await ok(c, "get_settings")).data as { approveIn: string }).approveIn;
  assert.equal(await approveIn(), "chat");
  assert.match(await fails(c, "update_settings", { approveIn: "chat" }), /^Nothing to change/);
  const set = await ok(c, "update_settings", { approveIn: "board" });
  assert.match(set.headline, /AI changes are approved on the board only/);
  assert.equal(await approveIn(), "board");
  assert.equal(await fails(c, "update_settings", { approveIn: "chat" }), `Only the board can switch this back. Open ${ORIGIN}/pending.`);
  assert.equal(await approveIn(), "board");
});

test("the board (owner) may switch approval back to chat", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const result = await updateSettings({ db, now: NOW, actor: "owner", tool: "update_settings" }, { approveIn: "chat" });
  assert.match(result.summary, /AI changes are approved in chat/);
});

test("with board approval apply_changes refuses without writing, and propose answers point at /pending", async () => {
  const { c, count } = await setup();
  await ok(c, "update_settings", { approveIn: "board" });
  const tasks = await count("tasks");
  const answer = await okText(c, "add_task", { deal: "dl_seed01", title: "Send Pat the quote", dueAt: "2026-11-20" });
  assert.ok(answer.headline.endsWith(`\n\nApprove on the board: ${ORIGIN}/pending.`), answer.headline);
  assert.ok(!answer.headline.includes("apply_changes"), "no yes in chat");
  const proposal = (answer.data as { proposal: string }).proposal;
  const audits = await count("audit_log");
  assert.equal(
    await fails(c, "apply_changes", { proposal }),
    `The owner approves changes on the board: ${ORIGIN}/pending. Ask them to open it and press Approve.`,
  );
  assert.equal(await count("tasks"), tasks);
  assert.equal(await count("audit_log"), audits);

  const listed = await okText(c, "propose_changes", { actions: [{ action: "add_task", title: "Buy ink" }] });
  assert.ok(listed.headline.endsWith(`Approve on the board: ${ORIGIN}/pending.`), listed.headline);
});

test("small changes still apply at once under Apply small changes while approval is on the board", async () => {
  const { c, count } = await setup();
  await ok(c, "update_settings", { aiEdits: "apply_small", approveIn: "board" });
  const activities = await count("activities");
  await ok(c, "log_activity", { deal: "dl_seed01", type: "note", summary: "Talked it over" });
  assert.equal(await count("activities"), activities + 1);
});
