import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { CampaignRecipientRow, CampaignRow, CampaignStepRow, Db } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Ctx } from "../services/change.ts";
import { CAMPAIGNS_OFF } from "../services/settings.ts";
import { undoChange } from "../services/undo.ts";
import { parseAudience, resolveAudience } from "./audience.ts";
import { addCampaignDraft, updateCampaignDraft } from "./drafts.ts";
import { approveCampaign, cancelCampaign, fingerprint, pauseCampaign, resumeCampaign } from "./freeze.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");
const DAY = 86_400_000;
const ctxFor = (db: Db, tool: string): Ctx => ({ db, now: NOW, actor: "owner", tool });
const BASE_URL = "https://board.example.com";

const campaignOf = (db: Db, id: string) => db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
const recipientsOf = async (db: Db, id: string) =>
  (await db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY contact_id").bind(id).all<CampaignRecipientRow>()).results;

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error && error.name === "UserError", `expected a UserError, got ${String(error)}`);
  return error.message;
}

async function draftOn(): Promise<{ db: SqliteD1; id: string }> {
  const db = await timeDb(NOW);
  db.exec(`UPDATE settings SET campaigns = 1;
    INSERT INTO contacts (id, name, email, person_status) VALUES
      ('ct_a1', 'Ann Example', 'Ann@Example.com', 'partner'),
      ('ct_b1', 'Bo Example', NULL, 'partner'),
      ('ct_c1', 'Cy Example', 'cy@example.com', 'partner'),
      ('ct_d1', 'Di Example', 'di@example.com', 'partner');
    INSERT INTO email_suppressions (id, email, reason, contact_id) VALUES ('su_1', 'di@example.com', 'unsubscribed', 'ct_d1');`);
  const added = await addCampaignDraft(
    { db, now: NOW, actor: "ai", tool: "add_campaign_draft" },
    { name: "Autumn news", recipients: { kind: "status", status: "partner" }, subject: "Hello {{first_name}}", body: "News inside." },
  );
  return { db, id: added.campaignId };
}

/** What the review page shows: the fingerprint of the draft and the list as they are now. */
async function openFingerprint(db: Db, id: string): Promise<string> {
  const campaign = await campaignOf(db, id);
  const step = await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? AND position = 1").bind(id).first<CampaignStepRow>();
  assert.ok(campaign && step);
  return fingerprint(campaign, step, await resolveAudience(db, NOW, parseAudience(campaign.audience)));
}

const sendNow = (fingerprint: string) => ({ fingerprint, sendAfter: NOW, baseUrl: BASE_URL, scheduled: false });

test("approve freezes one row per person: queued with a token, or skipped without", async () => {
  const { db, id } = await draftOn();
  const done = await approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)));
  assert.equal(done.summary, `Approved campaign ${id}: sending to 2 people (2 skipped) (change ${done.changeId})`);
  const row = await campaignOf(db, id);
  assert.deepEqual(
    [row?.status, row?.send_after, row?.approved_at, row?.base_url, row?.send_error, row?.version],
    ["sending", NOW.toISOString(), NOW.toISOString(), BASE_URL, null, 2],
  );
  const rows = await recipientsOf(db, id);
  assert.deepEqual(
    rows.map((r) => [r.contact_id, r.email, r.status, r.skip_reason, r.first_name]),
    [
      ["ct_a1", "ann@example.com", "queued", null, "Ann"],
      ["ct_b1", "", "skipped", "no_email", "Bo"],
      ["ct_c1", "cy@example.com", "queued", null, "Cy"],
      ["ct_d1", "di@example.com", "skipped", "unsubscribed", "Di"],
    ],
  );
  const stepId = await db.prepare("SELECT id FROM campaign_steps WHERE campaign_id = ?").bind(id).first<string>("id");
  assert.ok(rows.every((r) => r.step_id === stepId && r.id.startsWith("rc_")));
  const tokens = rows.filter((r) => r.status === "queued").map((r) => r.unsub_token ?? "");
  assert.ok(tokens.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t)));
  assert.equal(new Set(tokens).size, 2);
  assert.ok(rows.filter((r) => r.status === "skipped").every((r) => r.unsub_token === null));
  const audit = await db.prepare("SELECT tool, summary FROM audit_log WHERE id = ?").bind(done.changeId).first<{ tool: string; summary: string }>();
  assert.equal(audit?.tool, "campaign_approve");
});

test("schedule keeps the status scheduled and says when, in the owner's time", async () => {
  const { db, id } = await draftOn();
  const at = new Date(NOW.getTime() + 2 * DAY);
  const done = await approveCampaign(ctxFor(db, "campaign_schedule"), id, { ...sendNow(await openFingerprint(db, id)), sendAfter: at, scheduled: true });
  assert.equal(done.summary, `Scheduled campaign ${id} for Thu Nov 26, 10:00 AM: 2 people (2 skipped) (change ${done.changeId})`);
  const row = await campaignOf(db, id);
  assert.deepEqual([row?.status, row?.send_after, row?.approved_at], ["scheduled", at.toISOString(), NOW.toISOString()]);
});

test("the schedule must be in the next 90 days", async () => {
  const { db, id } = await draftOn();
  const print = await openFingerprint(db, id);
  const sentence = "Pick a time in the next 90 days.";
  for (const ms of [-DAY, 0, 91 * DAY]) {
    const sendAfter = new Date(NOW.getTime() + ms);
    assert.equal(await refusal(approveCampaign(ctxFor(db, "campaign_schedule"), id, { ...sendNow(print), sendAfter, scheduled: true })), sentence);
  }
  const edge = new Date(NOW.getTime() + 90 * DAY);
  await approveCampaign(ctxFor(db, "campaign_schedule"), id, { ...sendNow(print), sendAfter: edge, scheduled: true });
});

test("a changed draft refuses with the design's sentence and writes nothing", async () => {
  const { db, id } = await draftOn();
  const print = await openFingerprint(db, id);
  await updateCampaignDraft({ db, now: NOW, actor: "ai", tool: "update_campaign_draft" }, id, { subject: "A new subject" });
  assert.equal(
    await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(print))),
    "The list or the email changed since you opened this page. Check it again.",
  );
  assert.equal((await campaignOf(db, id))?.status, "draft");
  assert.equal((await recipientsOf(db, id)).length, 0);
});

test("a changed list refuses with the same sentence", async () => {
  const { db, id } = await draftOn();
  const print = await openFingerprint(db, id);
  db.exec("INSERT INTO contacts (id, name, email, person_status) VALUES ('ct_e1', 'Eve Example', 'eve@example.com', 'partner')");
  assert.equal(
    await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(print))),
    "The list or the email changed since you opened this page. Check it again.",
  );
});

test("the fingerprint changes when anyone's skip reason changes", async () => {
  const { db, id } = await draftOn();
  const before = await openFingerprint(db, id);
  db.exec("UPDATE email_suppressions SET reason = 'bounced'");
  assert.notEqual(await openFingerprint(db, id), before);
  assert.match(before, /^[0-9a-f]{64}$/);
});

test("nobody sendable, a missing, archived or already approved campaign, and a bad address are refused", async () => {
  const { db, id } = await draftOn();
  const print = await openFingerprint(db, id);
  assert.equal(
    await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, { ...sendNow(print), baseUrl: "https://board.example.com/path" })),
    "The board's address must be an https address with no path (http only on localhost).",
  );
  assert.equal(
    await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, { ...sendNow(print), baseUrl: "http://board.example.com" })),
    "The board's address must be an https address with no path (http only on localhost).",
  );
  assert.match(await refusal(approveCampaign(ctxFor(db, "campaign_approve"), "cp_nothing", sendNow(print))), /There's no campaign cp_nothing/);

  db.exec("UPDATE contacts SET email = NULL WHERE id IN ('ct_a1', 'ct_c1')");
  assert.equal(await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)))), "No one in this group can get the email.");
  db.exec("UPDATE contacts SET email = 'cy@example.com' WHERE id = 'ct_c1'");
  await approveCampaign(ctxFor(db, "campaign_approve"), id, { ...sendNow(await openFingerprint(db, id)), baseUrl: "http://localhost:4821/" });
  assert.equal((await campaignOf(db, id))?.base_url, "http://localhost:4821");
  assert.equal(await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(print))), "Only a draft can be approved.");
});

test("a hand-picked id that no longer exists is left out and approve still works", async () => {
  const { db } = await draftOn();
  db.exec("INSERT INTO contacts (id, name, email, person_status) VALUES ('ct_gone', 'Gone Example', 'gone@example.com', 'partner')");
  const added = await addCampaignDraft(
    { db, now: NOW, actor: "ai", tool: "add_campaign_draft" },
    { name: "Picked", recipients: { kind: "people", people: ["ct_a1", "ct_gone"] }, subject: "Hi", body: "News." },
  );
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DELETE FROM contacts WHERE id = 'ct_gone'");
  db.exec("PRAGMA foreign_keys = ON");
  const id = added.campaignId;
  await approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)));
  assert.deepEqual((await recipientsOf(db, id)).map((r) => r.contact_id), ["ct_a1"]);
});

test("an archived draft can't be approved", async () => {
  const { db, id } = await draftOn();
  const print = await openFingerprint(db, id);
  db.exec(`UPDATE campaigns SET archived = 1 WHERE id = '${id}'`);
  assert.match(await refusal(approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(print))), /is archived/);
});

test("every function refuses while campaigns are off", async () => {
  const db = await timeDb(NOW);
  const ctx = ctxFor(db, "campaign_approve");
  assert.equal(await refusal(approveCampaign(ctx, "cp_x", sendNow("x"))), CAMPAIGNS_OFF);
  assert.equal(await refusal(pauseCampaign(ctx, "cp_x")), CAMPAIGNS_OFF);
  assert.equal(await refusal(resumeCampaign(ctx, "cp_x")), CAMPAIGNS_OFF);
  assert.equal(await refusal(cancelCampaign(ctx, "cp_x")), CAMPAIGNS_OFF);
});

test("pause, resume and cancel move a campaign between statuses and refuse the wrong one", async () => {
  const { db, id } = await draftOn();
  assert.equal(await refusal(pauseCampaign(ctxFor(db, "campaign_pause"), id)), "Only a campaign that is sending can be paused.");
  assert.equal(await refusal(resumeCampaign(ctxFor(db, "campaign_resume"), id)), "Only a paused campaign can be resumed.");
  assert.equal(await refusal(cancelCampaign(ctxFor(db, "campaign_cancel"), id)), "Only a scheduled, sending or paused campaign can be cancelled.");
  await approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)));

  const paused = await pauseCampaign(ctxFor(db, "campaign_pause"), id);
  assert.equal(paused.summary, `Paused campaign ${id} (change ${paused.changeId})`);
  assert.equal((await campaignOf(db, id))?.status, "paused");
  assert.equal(await refusal(pauseCampaign(ctxFor(db, "campaign_pause"), id)), "Only a campaign that is sending can be paused.");

  db.exec(`UPDATE campaigns SET send_error = 'rate_limited' WHERE id = '${id}'`);
  const resumed = await resumeCampaign(ctxFor(db, "campaign_resume"), id);
  assert.equal(resumed.summary, `Resumed campaign ${id} (change ${resumed.changeId})`);
  assert.deepEqual([(await campaignOf(db, id))?.status, (await campaignOf(db, id))?.send_error], ["sending", null]);
});

test("cancel marks every queued row cancelled and leaves the others", async () => {
  const { db, id } = await draftOn();
  await approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)));
  db.exec(`UPDATE campaign_recipients SET status = 'sent' WHERE contact_id = 'ct_a1'`);
  await pauseCampaign(ctxFor(db, "campaign_pause"), id);
  const done = await cancelCampaign(ctxFor(db, "campaign_cancel"), id);
  assert.equal(done.summary, `Cancelled campaign ${id} (change ${done.changeId})`);
  const row = await campaignOf(db, id);
  assert.deepEqual([row?.status, row?.completed_at], ["cancelled", NOW.toISOString()]);
  assert.deepEqual(
    (await recipientsOf(db, id)).map((r) => [r.contact_id, r.status]),
    [["ct_a1", "sent"], ["ct_b1", "skipped"], ["ct_c1", "cancelled"], ["ct_d1", "skipped"]],
  );
  assert.equal(await refusal(cancelCampaign(ctxFor(db, "campaign_cancel"), id)), "Only a scheduled, sending or paused campaign can be cancelled.");
});

test("a scheduled campaign can be cancelled", async () => {
  const { db, id } = await draftOn();
  const sendAfter = new Date(NOW.getTime() + DAY);
  await approveCampaign(ctxFor(db, "campaign_schedule"), id, { ...sendNow(await openFingerprint(db, id)), sendAfter, scheduled: true });
  await cancelCampaign(ctxFor(db, "campaign_cancel"), id);
  assert.equal((await campaignOf(db, id))?.status, "cancelled");
});

test("an undo that would remove a person or campaign that campaign rows point at says so in plain words", async () => {
  const { db, id } = await draftOn();
  const person = await db.prepare("SELECT * FROM contacts WHERE id = 'ct_d1'").first<Record<string, unknown>>();
  await db
    .prepare(
      `INSERT INTO audit_log (id, at, actor, tool, target_table, target_id, before_json, after_json, summary)
       VALUES ('chg_addperson', '2026-11-24T17:00:00.000Z', 'owner', 'add_contact', 'contacts', 'ct_d1', ?, ?, 'Added contact')`,
    )
    .bind('{"contacts:ct_d1":null}', JSON.stringify({ "contacts:ct_d1": person }))
    .run();
  const added = await db.prepare("SELECT id FROM audit_log WHERE target_id = ?").bind(id).first<string>("id");
  await approveCampaign(ctxFor(db, "campaign_approve"), id, sendNow(await openFingerprint(db, id)));
  assert.equal(
    await refusal(undoChange(ctxFor(db, "undo_change"), "chg_addperson")),
    "Can't undo chg_addperson: other records now depend on it (1 campaign recipient and 1 campaign email block). Change those first, or leave it.",
  );

  const other = await draftOn();
  other.db.exec(`INSERT INTO campaign_batches (id, campaign_id, kind) VALUES ('cb_one', '${other.id}', 'test')`);
  const draftChange = await other.db.prepare("SELECT id FROM audit_log WHERE target_id = ?").bind(other.id).first<string>("id");
  assert.ok(added && draftChange);
  assert.equal(
    await refusal(undoChange(ctxFor(other.db, "undo_change"), draftChange)),
    `Can't undo ${draftChange}: other records now depend on it (1 sending attempt). Change those first, or leave it.`,
  );
});

