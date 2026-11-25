import assert from "node:assert/strict";
import { test } from "node:test";
import { call, CHANGE_LINE, connectInMemory, fails, ok } from "../../tests/helpers/mcp-client.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import { CAMPAIGNS_OFF } from "../services/settings.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ORIGIN = "https://pipeline.example.test";

async function setup(options: { on?: boolean; origin?: string | null } = {}) {
  const db = await timeDb(NOW);
  if (options.on !== false) db.exec("UPDATE settings SET campaigns = 1");
  db.exec(
    `INSERT INTO contacts (id, name, email, person_status) VALUES
       ('ct_p1', 'Ana Example', 'ana@example.com', 'partner'),
       ('ct_p2', 'Ben Example', 'ben@example.com', 'partner'),
       ('ct_p3', 'No Email', NULL, 'partner');`,
  );
  const origin = options.origin === null ? undefined : (options.origin ?? ORIGIN);
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, ...(origin === undefined ? {} : { origin }) }));
  return { db, c };
}

const DRAFT = {
  name: "Autumn news",
  recipients: { kind: "status", status: "partner" },
  subject: "Hello {{first_name}}",
  body: "Hi {{first_name}},\n\nNews inside.",
};

type Added = { campaignId: string; changeId: string; review_url: string };

test("no campaign tool is named for sending, scheduling, approving or stopping", async () => {
  const { c } = await setup();
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).filter((name) => name.includes("campaign"));
  assert.deepEqual(names.sort(), ["add_campaign_draft", "get_campaign", "list_campaigns", "preview_campaign_recipients", "update_campaign_draft"]);
  for (const name of names) assert.doesNotMatch(name, /send|schedule|approve|unsubscribe|pause|resume|cancel/, name);
  for (const tool of tools) assert.doesNotMatch(tool.name, /send|schedule|approve|unsubscribe|pause_campaign|cancel/, tool.name);
  assert.deepEqual(
    tools.filter((t) => t.annotations?.readOnlyHint === true && t.name.includes("campaign")).map((t) => t.name).sort(),
    ["get_campaign", "list_campaigns", "preview_campaign_recipients"],
  );
});

test("every campaign tool refuses while campaigns are off", async () => {
  const { c } = await setup({ on: false });
  const calls: [string, Record<string, unknown>][] = [
    ["list_campaigns", {}],
    ["get_campaign", { id: "cp_aaaaaaaaaaaa" }],
    ["preview_campaign_recipients", { id: "cp_aaaaaaaaaaaa" }],
    ["add_campaign_draft", DRAFT],
    ["update_campaign_draft", { id: "cp_aaaaaaaaaaaa", name: "New" }],
  ];
  for (const [tool, args] of calls) assert.equal(await fails(c, tool, args), CAMPAIGNS_OFF, tool);
});

test("drafts write at once even under Review first, and answer with the review address", async () => {
  const { db, c } = await setup();
  const settings = await ok(c, "get_settings");
  assert.equal((settings.data as { aiEdits: string }).aiEdits, "review_first");
  const added = await ok(c, "add_campaign_draft", DRAFT);
  assert.match(added.headline, /^Added campaign draft cp_[a-z2-7]{12} \(change chg_[a-z0-9]{12}\)$/);
  assert.match(added.headline, CHANGE_LINE);
  const data = added.data as Added;
  assert.equal(data.review_url, `${ORIGIN}/campaigns/${data.campaignId}`);
  const row = await db.prepare("SELECT status FROM campaigns WHERE id = ?").bind(data.campaignId).first<{ status: string }>();
  assert.equal(row?.status, "draft");
  const audit = await db.prepare("SELECT actor, tool FROM audit_log WHERE id = ?").bind(data.changeId).first<{ actor: string; tool: string }>();
  assert.deepEqual(audit, { actor: "ai", tool: "add_campaign_draft" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>())?.n, 0);

  const updated = await ok(c, "update_campaign_draft", { id: data.campaignId, subject: "Fresh subject", buttonLabel: "Book", buttonUrl: "https://example.com/book" });
  assert.match(updated.headline, /^Changed campaign draft cp_[a-z2-7]{12}: subject and button \(change chg_/);
  assert.equal((updated.data as Added).review_url, `${ORIGIN}/campaigns/${data.campaignId}`);
  const step = await db.prepare("SELECT subject, button_label FROM campaign_steps WHERE campaign_id = ?").bind(data.campaignId).first<{ subject: string; button_label: string }>();
  assert.deepEqual(step, { subject: "Fresh subject", button_label: "Book" });

  const cleared = await ok(c, "update_campaign_draft", { id: data.campaignId, buttonLabel: null, buttonUrl: null });
  assert.match(cleared.headline, /button/);
});

test("review_url is the plain path when the origin is unknown", async () => {
  const { c } = await setup({ origin: null });
  const added = (await ok(c, "add_campaign_draft", DRAFT)).data as Added;
  assert.equal(added.review_url, `/campaigns/${added.campaignId}`);
});

test("the recipients schema is strict and checks each kind", async () => {
  const { c } = await setup();
  assert.match(await fails(c, "add_campaign_draft", { ...DRAFT, recipients: { kind: "status", status: "partner", extra: 1 } }), /recipients/);
  assert.match(await fails(c, "add_campaign_draft", { ...DRAFT, recipients: { kind: "people", people: [] } }), /recipients/);
  assert.match(await fails(c, "add_campaign_draft", { ...DRAFT, extra: true }), /extra|unrecognized|Unrecognized/i);
  const people = await ok(c, "add_campaign_draft", { ...DRAFT, recipients: { kind: "people", people: ["ct_p1", "ct_p2"] } });
  assert.match(people.headline, /^Added campaign draft/);
});

test("get_campaign and list_campaigns give the draft with local times and no address", async () => {
  const { db, c } = await setup();
  const added = (await ok(c, "add_campaign_draft", { ...DRAFT, suggestedSendAt: "2026-11-25T09:00" })).data as Added;
  const got = await ok(c, "get_campaign", { id: added.campaignId });
  assert.equal(got.headline, `Campaign ${added.campaignId}: draft.`);
  const data = got.data as Record<string, unknown>;
  assert.equal(data.review_url, added.review_url);
  assert.equal(data.status, "draft");
  assert.deepEqual(data.audience, { kind: "status", status: "partner" });
  assert.equal(data.suggested_send_at, "2026-11-25T17:00:00.000Z");
  assert.equal(data.suggested_send_at_local, "Wed Nov 25, 9:00 AM");
  assert.equal(data.subject, "Hello {{first_name}}");
  assert.doesNotMatch(got.text, /unsub|@example\.com/);

  const listed = await ok(c, "list_campaigns");
  assert.equal(listed.headline, "1 campaign.");
  const items = (listed.data as { campaigns: { id: string; review_url: string }[] }).campaigns;
  assert.deepEqual(items.map((i) => i.id), [added.campaignId]);
  assert.equal((await ok(c, "list_campaigns", { status: "sent" })).headline, "No campaigns.");
  const drafts = await ok(c, "list_campaigns", { status: "draft" });
  assert.equal(drafts.headline, "1 campaign.");
  assert.deepEqual((drafts.data as { campaigns: { id: string }[] }).campaigns.map((i) => i.id), [added.campaignId]);

  // An approved campaign shows counts by recipient status and skip reason.
  db.exec(
    `UPDATE campaigns SET status = 'sending', approved_at = '2026-11-19T17:00:00.000Z' WHERE id = '${added.campaignId}';
     INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, first_name, status, skip_reason, unsub_token)
       SELECT 'rc_1', '${added.campaignId}', s.id, 'ct_p1', 'ana@example.com', 'Ana', 'queued', NULL, 'tok1' FROM campaign_steps s WHERE s.campaign_id = '${added.campaignId}';
     INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, first_name, status, skip_reason, unsub_token)
       SELECT 'rc_2', '${added.campaignId}', s.id, 'ct_p3', '', NULL, 'skipped', 'no_email', NULL FROM campaign_steps s WHERE s.campaign_id = '${added.campaignId}';
     INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, first_name, status, skip_reason, unsub_token)
       SELECT 'rc_3', '${added.campaignId}', s.id, 'ct_p2', '', NULL, 'cancelled', 'no_email', NULL FROM campaign_steps s WHERE s.campaign_id = '${added.campaignId}';`,
  );
  const sending = await ok(c, "get_campaign", { id: added.campaignId });
  const counts = sending.data as { recipients: Record<string, number>; skipped_by_reason: Record<string, number> };
  assert.deepEqual(counts.recipients, { queued: 1, skipped: 1, cancelled: 1 });
  // The same reason under two statuses adds up.
  assert.deepEqual(counts.skipped_by_reason, { no_email: 2 });
  assert.doesNotMatch(sending.text, /tok1|@example\.com/);
  const row = ((await ok(c, "list_campaigns")).data as { campaigns: { recipients: Record<string, number>; approved_at_local: string }[] }).campaigns[0];
  assert.deepEqual(row?.recipients, { queued: 1, skipped: 1, cancelled: 1 });
  assert.equal(row?.approved_at_local, "Thu Nov 19, 9:00 AM");
  assert.match(await fails(c, "get_campaign", { id: "cp_zzzzzzzzzzzz" }), /There's no campaign/);
});

test("preview_campaign_recipients gives counts, ids and labels, never an address", async () => {
  const { c } = await setup();
  const added = (await ok(c, "add_campaign_draft", DRAFT)).data as Added;
  const preview = await ok(c, "preview_campaign_recipients", { id: added.campaignId });
  assert.doesNotMatch(preview.text, /@/);
  const data = preview.data as { sendable: number; skipped: Record<string, number>; newLeads: number; people: { id: string; label: string }[]; review_url: string };
  assert.equal(data.sendable, 2);
  assert.deepEqual(data.skipped, { no_email: 1 });
  assert.equal(data.newLeads, 0);
  assert.deepEqual(data.people, [
    { id: "ct_p1", label: "Ana Example" },
    { id: "ct_p2", label: "Ben Example" },
  ]);
  assert.equal(data.review_url, added.review_url);
  assert.equal(preview.headline, "2 people would get this campaign; 1 skipped.");
});

test("a raw call with no arguments still answers a plain refusal", async () => {
  const { c } = await setup();
  const answer = await call(c, "get_campaign", {});
  assert.equal(answer.isError, true);
});
