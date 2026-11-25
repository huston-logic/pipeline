import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { CampaignRow, CampaignStepRow, Db } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Ctx } from "../services/change.ts";
import { CAMPAIGNS_OFF } from "../services/settings.ts";
import { undoChange } from "../services/undo.ts";
import { addCampaignDraft, archiveCampaign, duplicateCampaign, updateCampaignDraft } from "./drafts.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_campaign_draft"): Ctx => ({ db, now: NOW, actor: "ai", tool });
const campaign = (db: Db, id: string) => db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
const steps = async (db: Db, id: string) =>
  (await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position").bind(id).all<CampaignStepRow>()).results;

async function campaignsOnDb(): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  db.exec("UPDATE settings SET campaigns = 1");
  return db;
}

const BASE = {
  name: "Autumn news",
  recipients: { kind: "status", status: "contact" } as const,
  subject: "Hello {{first_name}}",
  body: "Hi {{first_name}},\n\nNews inside.",
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error && error.name === "UserError", `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("add writes the campaign and step 1 in one change", async () => {
  const db = await campaignsOnDb();
  const added = await addCampaignDraft(ctxFor(db), {
    ...BASE,
    name: "  Autumn news ",
    buttonLabel: "Book a call",
    buttonUrl: "https://example.com/book",
    suggestedSendAt: "2026-11-25T09:00",
  });
  assert.match(added.campaignId, /^cp_[a-z2-7]{12}$/);
  assert.equal(added.summary, `Added campaign draft ${added.campaignId} (change ${added.changeId})`);
  const row = await campaign(db, added.campaignId);
  assert.deepEqual(
    [row?.name, row?.status, row?.audience, row?.first_name_fallback, row?.suggested_send_at, row?.archived],
    ["Autumn news", "draft", '{"kind":"status","status":"contact"}', "there", "2026-11-25T17:00:00.000Z", 0],
  );
  const [step, ...more] = await steps(db, added.campaignId);
  assert.equal(more.length, 0);
  assert.deepEqual(
    [step?.position, step?.subject, step?.body, step?.button_label, step?.button_url],
    [1, "Hello {{first_name}}", "Hi {{first_name}},\n\nNews inside.", "Book a call", "https://example.com/book"],
  );
  const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE id = ?").bind(added.changeId).first<number>("n");
  assert.equal(audits, 1);
});

test("every draft function refuses while campaigns are off", async () => {
  const db = await timeDb(NOW);
  assert.equal(await refusal(addCampaignDraft(ctxFor(db), BASE)), CAMPAIGNS_OFF);
  assert.equal(await refusal(updateCampaignDraft(ctxFor(db), "cp_x", { subject: "x" })), CAMPAIGNS_OFF);
  assert.equal(await refusal(duplicateCampaign(ctxFor(db), "cp_x")), CAMPAIGNS_OFF);
  assert.equal(await refusal(archiveCampaign(ctxFor(db), "cp_x")), CAMPAIGNS_OFF);
});

test("a subject may hold emoji with joiners and variation selectors", async () => {
  const db = await campaignsOnDb();
  const subject = "Open house \u{1F3E1} this Friday \u{1F469}‍\u{1F4BB}";
  const added = await addCampaignDraft(ctxFor(db), { ...BASE, subject });
  assert.equal((await steps(db, added.campaignId))[0]?.subject, subject);
});

test("add needs a name, recipients, subject and body, in plain words", async () => {
  const db = await campaignsOnDb();
  const add = (patch: Record<string, unknown>) => addCampaignDraft(ctxFor(db), { ...BASE, ...patch });
  assert.equal(await refusal(add({ name: "  " })), "A campaign needs a name.");
  assert.equal(await refusal(add({ subject: "" })), "A campaign needs a subject.");
  assert.equal(await refusal(add({ body: undefined })), "A campaign needs a body.");
  assert.equal(await refusal(add({ recipients: undefined })), "A campaign needs recipients.");
  assert.match(await refusal(add({ name: "Two\nlines" })), /name must be one line/);
  assert.match(await refusal(add({ subject: "Two\nlines" })), /subject must be one line/);
  assert.match(await refusal(add({ name: "x".repeat(101) })), /name can be at most 100 characters/);
  assert.match(await refusal(add({ subject: "x".repeat(151) })), /subject can be at most 150 characters/);
  assert.match(await refusal(add({ body: "x".repeat(20001) })), /body can be at most 20000 characters/);
  assert.match(await refusal(add({ firstNameFallback: "x".repeat(41) })), /fallback can be at most 40 characters/);
  assert.match(await refusal(add({ firstNameFallback: " " })), /fallback/);
  assert.match(await refusal(add({ firstNameFallback: "friend\nof ours" })), /first-name fallback must be one line/);
  const ok = await add({ firstNameFallback: "friend" });
  assert.equal((await campaign(db, ok.campaignId))?.first_name_fallback, "friend");
});

test("a button needs both parts and an https address", async () => {
  const db = await campaignsOnDb();
  const add = (patch: Record<string, unknown>) => addCampaignDraft(ctxFor(db), { ...BASE, ...patch });
  assert.match(await refusal(add({ buttonLabel: "Book" })), /button needs both a label and an address/i);
  assert.match(await refusal(add({ buttonUrl: "https://example.com/" })), /button needs both a label and an address/i);
  assert.match(await refusal(add({ buttonLabel: "Book", buttonUrl: "http://example.com/" })), /https:\/\//);
  assert.match(await refusal(add({ buttonLabel: "Book", buttonUrl: "javascript:alert(1)" })), /https:\/\//);
  assert.match(await refusal(add({ buttonLabel: "Book", buttonUrl: `https://example.com/${"a".repeat(2000)}` })), /2000/);
  assert.match(await refusal(add({ buttonLabel: "x".repeat(41), buttonUrl: "https://example.com/" })), /button label can be at most 40/);
});

test("the audience is checked: status, view, people", async () => {
  const db = await campaignsOnDb();
  db.exec(`INSERT INTO views (id, name, module, sort, position) VALUES ('vw_people', 'Folks', 'people', 'name-asc', 1);
    INSERT INTO views (id, name, module, sort, position) VALUES ('vw_deals', 'Big', 'deals', 'name-asc', 2);
    INSERT INTO views (id, name, module, sort, position, archived) VALUES ('vw_old', 'Old', 'people', 'name-asc', 3, 1);
    UPDATE person_statuses SET archived = 1 WHERE key = 'partner';
    UPDATE contacts SET archived = 1 WHERE id = 'ct_seed08'`);
  const add = (recipients: unknown) => addCampaignDraft(ctxFor(db), { ...BASE, recipients } as never);

  assert.match(await refusal(add({ kind: "status", status: "partner" })), /^There's no live person status "partner"\./);
  assert.match(await refusal(add({ kind: "status", status: "nope" })), /^There's no live person status "nope"\./);
  assert.equal(await refusal(add({ kind: "view", view: "vw_deals" })), "That view lists deals. Pick a view of people.");
  assert.match(await refusal(add({ kind: "view", view: "vw_old" })), /archived/);
  assert.match(await refusal(add({ kind: "view", view: "vw_none" })), /^There's no view vw_none\./);
  assert.match(await refusal(add({ kind: "people", people: Array.from({ length: 501 }, (_, i) => `ct_${i}`) })), /at most 500 people/);
  assert.match(await refusal(add({ kind: "people", people: ["ct_seed01", "ct_nobody"] })), /ct_nobody/);
  assert.match(await refusal(add({ kind: "people", people: ["ct_seed08"] })), /ct_seed08/);
  assert.match(await refusal(add({ kind: "mystery" })), /status, view or people/);

  const view = await add({ kind: "view", view: "vw_people" });
  assert.equal((await campaign(db, view.campaignId))?.audience, '{"kind":"view","view":"vw_people"}');
  const people = await add({ kind: "people", people: ["ct_seed02", "ct_seed01", "ct_seed02"] });
  assert.equal((await campaign(db, people.campaignId))?.audience, '{"kind":"people","people":["ct_seed02","ct_seed01"]}');
  const nobody = await add({ kind: "people", people: [] });
  assert.equal((await campaign(db, nobody.campaignId))?.audience, '{"kind":"people","people":[]}');
});

test("the suggested send time is in the future, in the owner's timezone", async () => {
  const db = await campaignsOnDb();
  const add = (suggestedSendAt: string) => addCampaignDraft(ctxFor(db), { ...BASE, suggestedSendAt });
  assert.equal(await refusal(add("2026-11-18T09:00")), "The suggested send time must be in the future.");
  assert.match(await refusal(add("soon")), /isn't a date I can read/);
  const ok = await add("2026-12-01");
  assert.equal((await campaign(db, ok.campaignId))?.suggested_send_at, "2026-12-01T08:00:00.000Z");
});

test("update changes only what was given, only on a draft", async () => {
  const db = await campaignsOnDb();
  const { campaignId } = await addCampaignDraft(ctxFor(db), { ...BASE, suggestedSendAt: "2026-12-01" });
  const update = (patch: Parameters<typeof updateCampaignDraft>[2]) => updateCampaignDraft(ctxFor(db, "update_campaign_draft"), campaignId, patch);

  const changed = await update({ subject: "New subject", body: "New body", name: BASE.name });
  assert.equal(changed.campaignId, campaignId);
  assert.match(changed.summary, new RegExp(`^Changed campaign draft ${campaignId}: subject and body \\(change chg_`));
  const [step] = await steps(db, campaignId);
  assert.deepEqual([step?.subject, step?.body, step?.version], ["New subject", "New body", 2]);
  assert.equal((await campaign(db, campaignId))?.name, "Autumn news");

  assert.match(await refusal(update({ subject: "New subject" })), /^Nothing to change on campaign draft cp_/);
  assert.match(await refusal(update({})), /^Nothing to change/);
  assert.match(await refusal(update({ buttonLabel: "Book" })), /button needs both/i);

  const button = await update({ buttonLabel: "Book", buttonUrl: "https://example.com/b", suggestedSendAt: null, firstNameFallback: "friend" });
  assert.match(button.summary, /: button, first-name fallback and suggested send time \(change /);
  assert.equal((await campaign(db, campaignId))?.suggested_send_at, null);
  const cleared = await update({ buttonLabel: null, buttonUrl: null, recipients: { kind: "people", people: ["ct_seed01"] } });
  assert.match(cleared.summary, /: audience and button \(change /);
  assert.equal((await steps(db, campaignId))[0]?.button_url, null);

  db.exec(`UPDATE campaigns SET status = 'scheduled' WHERE id = '${campaignId}'`);
  assert.equal(await refusal(update({ subject: "Late" })), "Only a draft can be edited. Duplicate it to make a new draft.");
  assert.match(await refusal(updateCampaignDraft(ctxFor(db), "cp_nothere", { subject: "x" })), /^There's no campaign cp_nothere\. Use list_campaigns to find it\.$/);
});

test("duplicate makes a new draft from any campaign", async () => {
  const db = await campaignsOnDb();
  const original = await addCampaignDraft(ctxFor(db), {
    ...BASE,
    name: "n".repeat(100),
    buttonLabel: "Book",
    buttonUrl: "https://example.com/b",
    suggestedSendAt: "2026-12-01",
    firstNameFallback: "friend",
  });
  db.exec(`UPDATE campaigns SET status = 'sent', archived = 1 WHERE id = '${original.campaignId}'`);
  const copy = await duplicateCampaign(ctxFor(db, "duplicate_campaign"), original.campaignId);
  assert.equal(copy.summary, `Duplicated campaign ${original.campaignId} as ${copy.campaignId} (change ${copy.changeId})`);
  const row = await campaign(db, copy.campaignId);
  assert.equal(row?.name, `${"n".repeat(93)} (copy)`);
  assert.deepEqual([row?.status, row?.archived, row?.suggested_send_at, row?.first_name_fallback, row?.audience], ["draft", 0, null, "friend", '{"kind":"status","status":"contact"}']);
  const [step] = await steps(db, copy.campaignId);
  assert.deepEqual([step?.subject, step?.body, step?.button_label, step?.button_url, step?.position], [BASE.subject, BASE.body, "Book", "https://example.com/b", 1]);
  assert.match(await refusal(duplicateCampaign(ctxFor(db), "cp_nothere")), /^There's no campaign cp_nothere\./);
});

test("archive works on a draft only", async () => {
  const db = await campaignsOnDb();
  const { campaignId } = await addCampaignDraft(ctxFor(db), BASE);
  const archived = await archiveCampaign(ctxFor(db, "archive_campaign"), campaignId);
  assert.equal(archived.summary, `Archived campaign draft ${campaignId} (change ${archived.changeId})`);
  assert.equal((await campaign(db, campaignId))?.archived, 1);
  assert.match(await refusal(archiveCampaign(ctxFor(db), campaignId)), /already archived/);

  const other = await addCampaignDraft(ctxFor(db), BASE);
  db.exec(`UPDATE campaigns SET status = 'sending' WHERE id = '${other.campaignId}'`);
  assert.equal(await refusal(archiveCampaign(ctxFor(db), other.campaignId)), "Only a draft can be archived.");
});

test("undo of an add removes both rows", async () => {
  const db = await campaignsOnDb();
  const added = await addCampaignDraft(ctxFor(db), BASE);
  await undoChange(ctxFor(db, "undo_change"), added.changeId);
  assert.equal(await campaign(db, added.campaignId), null);
  assert.equal((await steps(db, added.campaignId)).length, 0);
});
