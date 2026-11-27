// The Campaigns pages on the board (decision 0053): the More item, the list grouped by status and Campaign settings.
// Every /campaigns path is a 404 while campaigns are off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { getSettings } from "../db/queries.ts";
import { type ActionContext, page } from "./action-kit.ts";
import { newCsrfToken } from "./csrf.ts";
import { handleBoardPost } from "./post.ts";
import { boardRoutes, moreItems, moreItemsFor } from "./routes.ts";

async function campaignsDb(on = true): Promise<SqliteD1> {
  const db = await seededDb(new Date());
  if (on) db.exec("UPDATE settings SET campaigns = 1");
  return db;
}

function addCampaign(db: SqliteD1, id: string, name: string, status: string, subject: string, extra = "", archived = 0): void {
  db.exec(`INSERT INTO campaigns (id, name, status, audience, archived${extra === "" ? "" : ", " + extra.split("=")[0]}) VALUES ('${id}', '${name}', '${status}', '{"kind":"status","status":"contact"}', ${archived}${extra === "" ? "" : ", " + extra.split("=")[1]});
    INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES ('cs_${id.slice(3)}', '${id}', 1, '${subject}', 'Body text.')`);
}

test("Marketing is a tab from 60rem up while campaigns are on, and More lists it for phones", async () => {
  assert.ok(!moreItems.some((item) => item.href === "/campaigns"));
  assert.ok(moreItemsFor({ timeTracking: false, campaigns: true }).some((item) => item.href === "/campaigns" && item.label === "Marketing"));
  assert.deepEqual(moreItemsFor({ timeTracking: false, campaigns: false }), moreItems);
  const both = moreItemsFor({ timeTracking: true, campaigns: true }).map((item) => item.href);
  assert.ok(both.indexOf("/campaigns") > both.indexOf("/time"));

  const on = await campaignsDb();
  const off = await campaignsDb(false);
  assert.match((await load(devEnv(on), "/more")).body, /<a class="card card-link" href="\/campaigns">[\s\S]*?<span class="card-title">Marketing<\/span>/);
  assert.doesNotMatch((await load(devEnv(off), "/more")).body, /href="\/campaigns"/);
  assert.match((await load(devEnv(on), "/")).body, /<li class="nav-wide-only"><a href="\/campaigns">/);
  assert.doesNotMatch((await load(devEnv(off), "/")).body, /href="\/campaigns"/);
  assert.match((await load(devEnv(on), "/campaigns")).body, /<a href="\/campaigns" aria-current="page">/);
});

test("every campaigns path is a 404 while campaigns are off, for GET and POST", async () => {
  const db = await campaignsDb(false);
  const env = devEnv(db);
  const before = await auditCount(db);
  for (const path of ["/campaigns", "/campaigns/settings"]) {
    const page = await load(env, path);
    assert.equal(page.res.status, 404, path);
  }
  const posted = await post(env, "/campaigns/settings", { postal_address: "100 Example Street, Springfield", daily_limit: "50" });
  assert.equal(posted.res.status, 404);
  assert.equal(await auditCount(db), before);
});

test("the campaigns pages are in boardRoutes", () => {
  for (const path of ["/campaigns", "/campaigns/settings"]) assert.ok(boardRoutes.includes(path), path);
});

test("the list groups by status in order, leaves out archived and names the campaign as the link", async () => {
  const db = await campaignsDb();
  addCampaign(db, "cp_sent", "Autumn news", "sent", "What happened", "completed_at='2026-11-02T18:00:00.000Z'");
  addCampaign(db, "cp_draft", "Winter invite", "draft", "Come along");
  addCampaign(db, "cp_sched", "Spring sale", "scheduled", "Spring is here", "send_after='2026-12-01T17:00:00.000Z'");
  addCampaign(db, "cp_gone", "Old draft", "draft", "Nope", "", 1);
  addCampaign(db, "cp_cancel", "Called off", "cancelled", "Never mind");
  const { res, body } = await load(devEnv(db), "/campaigns");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h1>Campaigns<\/h1>/);
  assert.match(body, /<a [^>]*href="\/campaigns\/new"[^>]*>New campaign<\/a>/);
  assert.match(body, /<a [^>]*href="\/campaigns\/settings"[^>]*>Campaign settings<\/a>/);
  const headings = [...body.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["Draft", "Scheduled", "Sent", "Cancelled"]);
  assert.match(body, /<a href="\/campaigns\/cp_draft">Winter invite<\/a>/);
  assert.match(body, /Come along/);
  assert.doesNotMatch(body, /Old draft/);
  assert.match(body, /<time datetime="2026-12-01T17:00:00.000Z">[^<]*Dec 1[^<]*<\/time>/);
  assert.match(body, /<time datetime="2026-11-02T18:00:00.000Z">/);
});

test("with no campaigns the list says so", async () => {
  const { body } = await load(devEnv(await campaignsDb()), "/campaigns");
  assert.match(body, /No campaigns yet\./);
  assert.doesNotMatch(body, /<h2/);
});

test("the settings page shows the stored values and the hints", async () => {
  const db = await campaignsDb();
  db.exec("UPDATE settings SET postal_address = '100 Example Street, Springfield', campaign_daily_limit = 80");
  const { res, body } = await load(devEnv(db), "/campaigns/settings");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /Shown at the bottom of every campaign email\./);
  assert.match(body, /The most campaign emails sent in one day\. Resend&#39;s free plan allows 100 a day in all\./);
  assert.match(body, /100 Example Street, Springfield/);
  assert.match(body, /value="80"/);
});

test("saving settings sends only the changed fields, as the owner, and answers 303 with ?change=", async () => {
  const db = await campaignsDb();
  db.exec("UPDATE settings SET postal_address = '100 Example Street, Springfield', campaign_daily_limit = 80");
  const env = devEnv(db);
  const page = await load(env, "/campaigns/settings");
  const fields = formFields(page.body, "/campaigns/settings");
  fields.set("daily_limit", "120");
  const before = await auditCount(db);
  const { res, location } = await post(env, "/campaigns/settings", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/campaigns\/settings\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_settings");
  assert.match(audit?.summary ?? "", /^Updated settings: campaign daily limit 120 \(change chg_/);
  const settings = await getSettings(db);
  assert.equal(settings.campaign_daily_limit, 120);
  assert.equal(settings.postal_address, "100 Example Street, Springfield");
});

test("an empty postal address clears it", async () => {
  const db = await campaignsDb();
  db.exec("UPDATE settings SET postal_address = '100 Example Street, Springfield'");
  const env = devEnv(db);
  const page = await load(env, "/campaigns/settings");
  const fields = formFields(page.body, "/campaigns/settings");
  fields.set("postal_address", "");
  const { res } = await post(env, "/campaigns/settings", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.equal((await getSettings(db)).postal_address, null);
});

test("a refused limit is a 422 that keeps the values and writes nothing", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/settings");
  const fields = formFields(page.body, "/campaigns/settings");
  fields.set("postal_address", "200 Example Road, Springfield");
  fields.set("daily_limit", "9000");
  const before = await auditCount(db);
  const { res, body } = await post(env, "/campaigns/settings", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 422);
  assert.equal(h1Count(body), 1);
  assert.match(body, /between 1 and 5000/);
  assert.match(body, /200 Example Road, Springfield/);
  assert.match(body, /value="9000"/);
  assert.equal(await auditCount(db), before);
});

test("a board action gets the signed-in email and the request's origin", async () => {
  const token = newCsrfToken();
  const request = new Request("https://board.example.com/anything", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://board.example.com", Cookie: `__Host-pipeline-csrf=${token}` },
    body: new URLSearchParams({ csrf: token }).toString(),
  });
  let seen: ActionContext | null = null;
  const action = {
    maxBytes: 16_384,
    upload: false,
    run: async (ctx: ActionContext) => {
      seen = ctx;
      return page(200, "ok");
    },
  };
  const res = await handleBoardPost(request, devEnv(await campaignsDb()), "production", async () => ({ ok: true, email: "owner@example.com" }), action);
  assert.equal(res.status, 200);
  const got = seen as ActionContext | null;
  assert.equal(got?.email, "owner@example.com");
  assert.equal(got?.origin, "https://board.example.com");
});

test("saving with nothing changed is a 422", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/settings");
  const { res, body } = await post(env, "/campaigns/settings", formFields(page.body, "/campaigns/settings"), { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 422);
  assert.match(body, /Nothing to save/);
});
