import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { UserError } from "./errors.ts";
import { CAMPAIGNS_OFF, getSettings, requireCampaigns, updateSettings } from "./settings.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db): Ctx => ({ db, now: NOW, actor: "ai", tool: "update_settings" });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

test("campaign settings start off, with no address and a limit of 90", async () => {
  const db = await openTestDb();
  const view = await getSettings(db);
  assert.equal(view.campaigns, false);
  assert.equal(view.postalAddress, null);
  assert.equal(view.campaignDailyLimit, 90);
});

test("requireCampaigns refuses while off and passes once on", async () => {
  const db = await openTestDb();
  assert.equal(await refusal(requireCampaigns(db)), CAMPAIGNS_OFF);
  assert.equal(CAMPAIGNS_OFF, "Campaigns are off. The owner can turn them on (update_settings campaigns true).");
  await updateSettings(ctxFor(db), { campaigns: true });
  await requireCampaigns(db);
});

test("updateSettings writes and summarises the campaign settings without the address", async () => {
  const db = await openTestDb();
  const result = await updateSettings(ctxFor(db), {
    campaigns: true,
    postalAddress: "  12 Example Road \n\n Suite 4  \n Springfield, EX 00000\n\n",
    campaignDailyLimit: 120,
  });
  assert.equal(
    result.summary,
    `Updated settings: campaigns on, postal address set and campaign daily limit 120 (change ${result.changeId})`,
  );
  const view = await getSettings(db);
  assert.equal(view.campaigns, true);
  assert.equal(view.postalAddress, "12 Example Road\n\nSuite 4\nSpringfield, EX 00000");
  assert.equal(view.campaignDailyLimit, 120);

  const cleared = await updateSettings(ctxFor(db), { postalAddress: null, campaigns: false });
  assert.match(cleared.summary, /^Updated settings: campaigns off and postal address cleared \(change /);
  assert.equal((await getSettings(db)).postalAddress, null);
});

test("a postal address must be 1 to 300 characters; null clears, empty is refused", async () => {
  const db = await openTestDb();
  assert.match(await refusal(updateSettings(ctxFor(db), { postalAddress: "x".repeat(301) })), /at most 300 characters/);
  assert.match(await refusal(updateSettings(ctxFor(db), { postalAddress: "  \n " })), /null to clear/);
  const ok = await updateSettings(ctxFor(db), { postalAddress: "x".repeat(300) });
  assert.match(ok.summary, /postal address set/);
});

test("the campaign daily limit is a whole number from 1 to 5000", async () => {
  const db = await openTestDb();
  for (const bad of [0, 5001, 1.5, -3]) {
    assert.match(await refusal(updateSettings(ctxFor(db), { campaignDailyLimit: bad })), /between 1 and 5000/);
  }
  await updateSettings(ctxFor(db), { campaignDailyLimit: 5000 });
  assert.equal((await getSettings(db)).campaignDailyLimit, 5000);
});
