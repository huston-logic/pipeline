import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { CHANGE_LINE, connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import type { AuditRow } from "../db/db.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW }));
  const audits = async () => (await db.prepare("SELECT * FROM audit_log ORDER BY rowid").all<AuditRow>()).results;
  return { db, c, audits };
}

type Proposed = { proposal: string; expiresAt: string; list: { add: unknown[]; update: unknown[]; tasks: { id: string }[]; notes: unknown[]; time: unknown[] } };

test("propose_changes answers the list, a blank line and the JSON; apply_changes writes it as one change as ai", async () => {
  const { c, audits } = await setup();
  const answer = await okText(c, "propose_changes", {
    actions: [
      { action: "add_task", contact: "Pat", title: "Send Pat the examples" },
      { action: "update_deal", deal: "Pat", stage: "Proposal sent" },
    ],
  });
  const data = answer.data as Proposed;
  assert.match(data.proposal, /^pr_[a-z2-7]{12}$/);
  assert.equal(data.expiresAt, "2026-11-19T20:00:00.000Z");
  assert.ok(answer.headline.startsWith(`Proposal ${data.proposal} (expires 12:00 PM). Nothing has changed yet.\n\nUpdate\n`), answer.headline);
  assert.ok(answer.headline.endsWith('"No" (apply nothing).'));
  assert.equal(data.list.tasks.length, 1);
  assert.equal((await audits()).length, 0);

  const applied = await ok(c, "apply_changes", { proposal: data.proposal });
  assert.match(applied.headline, new RegExp(`^Applied ${data.proposal}: Added task "Send Pat the examples" for Pat Example; Moved `));
  assert.match(applied.headline, CHANGE_LINE);
  const { changeId, applied: count } = applied.data as { changeId: string; applied: number };
  assert.equal(count, 2);
  const log = await audits();
  assert.deepEqual(log.map((row) => [row.id, row.actor, row.tool]), [[changeId, "ai", "apply_changes"]]);
});

test("a name with several matches answers questions and stores nothing; bad actions name the field", async () => {
  const { db, c } = await setup();
  db.exec("INSERT INTO contacts (id, name) VALUES ('ct_dana1', 'Dana Example'), ('ct_dana2', 'Dana Sample')");
  const answer = await okText(c, "propose_changes", { actions: [{ action: "add_task", contact: "Dana", title: "Call Dana" }] });
  assert.match(answer.headline, /^Nothing was proposed: a name needs checking first\. Ask the owner, then send the list again\.\n- Which Dana\? /);
  assert.deepEqual(Object.keys(answer.data as object), ["questions"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM proposals").first<number>("n")), 0);

  assert.match(await fails(c, "propose_changes", { actions: [{ action: "delete_deal", deal: "Pat" }] }), /"actions\.0\.action" must be one of: add_lead, add_deal/);
  assert.match(await fails(c, "propose_changes", { actions: [{ action: "add_task", contact: "Pat" }] }), /"actions\.0\.title" is missing/);
  assert.match(await fails(c, "propose_changes", { actions: [] }), /needs at least 1 item/);
  assert.match(await fails(c, "apply_changes", { proposal: "pr_nothing" }), /^No proposal pr_nothing\. Propose the changes again\.$/);
});

test("the tools' hints: propose writes only scratch space, apply is destructive", async () => {
  const { c } = await setup();
  const { tools } = await c.listTools();
  const hints = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
  assert.deepEqual(hints("propose_changes"), { title: "Propose record changes", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(hints("apply_changes"), { title: "Apply proposed changes", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
});
