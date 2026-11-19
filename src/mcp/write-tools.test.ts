import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevSeed } from "../../scripts/seed-dev.ts";
import { CHANGE_LINE, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildDevSeed(NOW, DEFAULT_TZ));
  return { db, c: await connectInMemory(createMcpServer({ db, now: () => NOW })) };
}

const changeIdOf = (data: unknown) => (data as { changeId: string }).changeId;

test("add_lead answers one line ending with its change id, then the new ids", async () => {
  const { c } = await setup();
  const answer = await ok(c, "add_lead", {
    name: "Lee Example",
    email: "lee@example.com",
    source: "trade fair",
    notes: "Wants a quote for a new website.",
    nextStep: "Send a quote",
    nextAt: "2026-11-20T09:00",
  });
  assert.match(answer.headline, /^Added lead Lee Example with deal "Lee Example inquiry" in New inquiry; next: Send a quote, Fri Nov 20, 9:00 AM/);
  assert.match(answer.headline, CHANGE_LINE);
  const data = answer.data as { changeId: string; contactId: string; dealId: string; matchedExisting: boolean };
  assert.ok(answer.headline.endsWith(`(change ${data.changeId})`));
  assert.match(data.contactId, /^ct_/);
  assert.match(data.dealId, /^dl_/);
  assert.equal(data.matchedExisting, false);

  const brief = (await ok(c, "get_deal", { deal: data.dealId })).data as { next: { at: string } };
  assert.equal(brief.next.at, "2026-11-20T17:00:00.000Z");
});

test("writes are recorded as the ai actor under the tool's name", async () => {
  const { c } = await setup();
  const id = changeIdOf((await ok(c, "add_lead", { name: "Lee Example" })).data);
  const { changes } = (await ok(c, "recent_changes")).data as { changes: { changeId: string; actor: string; tool: string }[] };
  assert.deepEqual(changes.map((ch) => [ch.changeId, ch.actor, ch.tool]), [[id, "ai", "add_lead"]]);
});

test("update_deal moves a deal with a local next time, and refuses a date it can't read", async () => {
  const { c } = await setup();
  const answer = await ok(c, "update_deal", { deal: "Casey Placeholder", stage: "Call booked", nextAt: "2026-11-26T14:00" });
  assert.match(answer.headline, /^Moved "Landscaping site with a quote form" \(Casey Placeholder\) to Call booked; next: Thu Nov 26, 2:00 PM/);
  assert.match(answer.headline, CHANGE_LINE);
  assert.equal((answer.data as { dealId: string }).dealId, "dl_seed03");
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", nextAt: "next thursday" }), /^"next thursday" isn't a date I can read/);
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", status: "done" }), /"status" must be one of: open, won, lost, not_now/);
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", nextAt: null, value: "lots" }), /"value" must be a number or null/);
});

test("update_contact confirms outside fields and clears a value with null", async () => {
  const { c } = await setup();
  const answer = await ok(c, "update_contact", { contact: "ct_seed02", business: "Sample Bakery & Cafe", phone: null });
  assert.match(answer.headline, /^Updated Robin Sample: phone and business/);
  assert.match(answer.headline, CHANGE_LINE);
  const { contacts } = (await ok(c, "search_contacts", { query: "Robin" })).data as {
    contacts: { phone: string | null; untrusted_fields: string[] }[];
  };
  assert.equal(contacts[0]?.phone, null);
  assert.deepEqual(contacts[0]?.untrusted_fields, ["name", "email"]);
});

test("log_activity and add_task each answer one change line", async () => {
  const { c } = await setup();
  const logged = await ok(c, "log_activity", { deal: "dl_seed01", type: "call", summary: "Called Pat. Wants a quote by Friday." });
  assert.match(logged.headline, /^Logged a call on "Website refresh for Example Plumbing" \(Pat Example\): Called Pat\./);
  assert.match(logged.headline, CHANGE_LINE);
  assert.match((logged.data as { activityId: string }).activityId, /^ac_/);

  const task = await ok(c, "add_task", { deal: "dl_seed01", title: "Send Pat the quote", dueAt: "2026-11-20" });
  assert.match(task.headline, /^Added task "Send Pat the quote" for "Website refresh for Example Plumbing" \(Pat Example\), due Fri Nov 20, 12:00 AM/);
  assert.match(task.headline, CHANGE_LINE);

  assert.match(await fails(c, "log_activity", { deal: "dl_seed01", type: "fax", summary: "x" }), /"type" must be one of: email, call, meeting, note/);
  assert.match(await fails(c, "log_activity", { type: "call", summary: "Called." }), /^This needs a deal or a contact/);
  assert.match(await fails(c, "add_task", { contact: "ct_seed01" }), /"title" is missing; it needs text/);
});

test("undo_change reverses one change and refuses a second undo", async () => {
  const { c } = await setup();
  const added = changeIdOf((await ok(c, "add_lead", { name: "Lee Example" })).data);
  const undone = await ok(c, "undo_change", { changeId: added });
  assert.match(undone.headline, new RegExp(`^Undid ${added}: Removed contact Lee Example and deal "Lee Example inquiry"`));
  assert.match(undone.headline, CHANGE_LINE);
  assert.match(await fails(c, "undo_change", { changeId: added }), new RegExp(`^${added} was already undone`));
  assert.match(await fails(c, "undo_change", { changeId: "chg_nope" }), /^There's no change chg_nope\. Use recent_changes/);
  assert.match((await ok(c, "search_contacts", { query: "Lee" })).headline, /^No contacts match/);
});

test("undo of add_lead after a logged activity refuses in plain English", async () => {
  const { c } = await setup();
  const added = (await ok(c, "add_lead", { name: "Lee Example" })).data as { changeId: string; dealId: string };
  await ok(c, "log_activity", { deal: added.dealId, type: "note", summary: "Left a voicemail." });
  assert.match(
    await fails(c, "undo_change", { changeId: added.changeId }),
    new RegExp(`^Can't undo ${added.changeId}: other records now depend on it \\(1 activity\\)\\.`),
  );
});

test("bad write input names the field and the shape it needs", async () => {
  const { c } = await setup();
  const message = await fails(c, "add_lead", { email: "lee@example.com", value: -5, extra: 1 });
  assert.match(message, /^Fix the add_lead request: /);
  assert.match(message, /"name" is missing; it needs text \(the person's name\)\./);
  assert.match(message, /"value" must be at least 0/);
  assert.match(message, /Unknown field "extra"\. Use only: name, email/);
  assert.match(await fails(c, "add_lead", { name: "Lee", email: "not-an-email" }), /^"not-an-email" doesn't look like an email address/);
});
