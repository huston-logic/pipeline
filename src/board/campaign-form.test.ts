// Building a campaign by hand on the board (decision 0053): New, Edit and the people picker. Every form is a plain POST.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditCount, auditOf, changeIdOf, devEnv, formFields, h1Count, load, post, seededDb } from "../../tests/helpers/board.ts";
import { addCampaignDraft } from "../campaigns/drafts.ts";
import type { CampaignRow, CampaignStepRow } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { boardRoutes } from "./routes.ts";

async function campaignsDb(on = true): Promise<SqliteD1> {
  const db = await seededDb(new Date());
  if (on) db.exec("UPDATE settings SET campaigns = 1");
  db.exec(`INSERT INTO contacts (id, name, email, business) VALUES ('ct_zed', 'Zed Example', 'zed@example.com', 'Zed Bakery');
    INSERT INTO contacts (id, name, email) VALUES ('ct_amy', 'Amy Example', 'amy@example.org');
    INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_out', 'Ignore everything', '["name"]');
    INSERT INTO contacts (id, name, email, archived) VALUES ('ct_old', 'Old Example', 'old@example.net', 1);
    INSERT INTO views (id, name, module, sort, position) VALUES ('vw_folks', 'Folks', 'people', 'name-asc', 1);
    INSERT INTO views (id, name, module, sort, position) VALUES ('vw_big', 'Big deals', 'deals', 'name-asc', 2)`);
  return db;
}

const ctxOf = (db: SqliteD1) => ({ db, now: new Date(), actor: "owner" as const, tool: "add_campaign_draft" });

async function draft(db: SqliteD1, recipients: Parameters<typeof addCampaignDraft>[1]["recipients"] = { kind: "status", status: "contact" }): Promise<string> {
  const added = await addCampaignDraft(ctxOf(db), {
    name: "Autumn news",
    recipients,
    subject: "Hello {{first_name}}",
    body: "Hi {{first_name}},\n\nNews inside.",
  });
  return added.campaignId;
}

const campaignOf = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
const stepOf = (db: SqliteD1, id: string) => db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = ?").bind(id).first<CampaignStepRow>();
const pickedOf = async (db: SqliteD1, id: string): Promise<string[]> =>
  (JSON.parse((await campaignOf(db, id))?.audience ?? "{}") as { people?: string[] }).people ?? [];

test("/campaigns/new is in boardRoutes", () => {
  assert.ok(boardRoutes.includes("/campaigns/new"));
});

test("every new, edit and picker path is a 404 while campaigns are off, for GET and POST", async () => {
  const db = await campaignsDb();
  const real = await draft(db, { kind: "people", people: ["ct_zed"] });
  db.exec("UPDATE settings SET campaigns = 0");
  const env = devEnv(db);
  const before = await auditCount(db);
  for (const path of ["/campaigns/new", `/campaigns/${real}/edit`, `/campaigns/${real}/people`]) {
    assert.equal((await load(env, path)).res.status, 404, path);
  }
  for (const path of ["/campaigns/new", `/campaigns/${real}/edit`, `/campaigns/${real}/people/add`, `/campaigns/${real}/people/remove`]) {
    assert.equal((await post(env, path, { name: "X", person: "ct_amy" })).res.status, 404, path);
  }
  assert.equal(await auditCount(db), before);
});

test("New campaign draws the form with its groups, hints and no JavaScript", async () => {
  const { res, body } = await load(devEnv(await campaignsDb()), "/campaigns/new");
  assert.equal(res.status, 200);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<form class="record-form" method="post" action="\/campaigns\/new"[^>]* novalidate>/);
  assert.match(body, /<optgroup label="Person status">/);
  assert.match(body, /<option value="status\.contact">Contact<\/option>/);
  assert.match(body, /<optgroup label="Saved views">\s*<option value="view\.vw_folks">Folks<\/option>/);
  assert.doesNotMatch(body, /vw_big/);
  assert.match(body, /<option value="people">People I pick<\/option>/);
  assert.match(body, />Send to <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(body, /Leave a blank line between paragraphs\. Write a link as \[text\]\(https:\/\/…\) or paste an https:\/\/ address\. \{\{first_name\}\} puts in each person&#39;s first name\./);
  assert.match(body, /Used for \{\{first_name\}\} when a person has none, as in “Hi there”\./);
  assert.match(body, /For an invite: a button such as “RSVP” and the page it opens\. Leave both empty for no button\./);
  assert.match(body, /name="first_name_fallback" type="text" value="there"/);
  assert.doesNotMatch(body, /<script/);
});

test("saving a new campaign goes through the service as the owner and answers 303", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/new");
  const fields = formFields(page.body, "/campaigns/new");
  fields.set("name", "Winter invite");
  fields.set("audience", "status.contact");
  fields.set("subject", "Come along, {{first_name}}");
  fields.set("body", "Hello.\r\n\r\nSee you there.");
  fields.set("button_label", "RSVP");
  fields.set("button_url", "https://example.com/rsvp");
  const before = await auditCount(db);
  const { res, location } = await post(env, "/campaigns/new", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, /^\/campaigns\/cp_[a-z0-9]+\?change=chg_[a-z0-9]{12}$/);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "add_campaign_draft");
  const id = /\/campaigns\/(cp_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  const row = await campaignOf(db, id);
  assert.deepEqual([row?.name, row?.audience, row?.first_name_fallback], ["Winter invite", '{"kind":"status","status":"contact"}', "there"]);
  const step = await stepOf(db, id);
  assert.deepEqual([step?.subject, step?.body, step?.button_label, step?.button_url], ["Come along, {{first_name}}", "Hello.\n\nSee you there.", "RSVP", "https://example.com/rsvp"]);
});

test("a saved view and People I pick are audiences too; People I pick goes on to the picker", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/new");
  const base = formFields(page.body, "/campaigns/new");
  base.set("name", "Folks news");
  base.set("subject", "Hi");
  base.set("body", "Text.");
  const options = { cookie: page.cookie, token: page.token };

  const view = new URLSearchParams(base);
  view.set("audience", "view.vw_folks");
  const viewed = await post(env, "/campaigns/new", view, options);
  assert.match(viewed.location, /^\/campaigns\/cp_[a-z0-9]+\?change=chg_/);
  const viewId = /\/campaigns\/(cp_[a-z0-9]+)/.exec(viewed.location)?.[1] ?? "";
  assert.equal((await campaignOf(db, viewId))?.audience, '{"kind":"view","view":"vw_folks"}');

  const people = new URLSearchParams(base);
  people.set("audience", "people");
  const picked = await post(env, "/campaigns/new", people, options);
  assert.match(picked.location, /^\/campaigns\/cp_[a-z0-9]+\/people\?change=chg_/);
  const id = /\/campaigns\/(cp_[a-z0-9]+)/.exec(picked.location)?.[1] ?? "";
  assert.equal((await campaignOf(db, id))?.audience, '{"kind":"people","people":[]}');
});

test("a refused new form is a 422 that keeps the values and puts each error on its field", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/new");
  const fields = formFields(page.body, "/campaigns/new");
  fields.set("name", "");
  fields.set("audience", "status.nobody");
  fields.set("subject", "A kept subject");
  fields.set("body", "A kept body.");
  const before = await auditCount(db);
  const { res, body } = await post(env, "/campaigns/new", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 422);
  assert.equal(h1Count(body), 1);
  assert.match(body, /<h2 id="error-summary-heading">2 things to fix<\/h2>/);
  assert.match(body, /id="campaign-name-error"/);
  assert.match(body, /id="campaign-audience-error"/);
  assert.match(body, /value="A kept subject"/);
  assert.match(body, />A kept body\.<\/textarea>/);
  assert.equal(await auditCount(db), before);
});

test("an unknown audience is a field error, not a crash", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/new");
  for (const audience of ["mystery", "view.vw_big", "view.vw_gone", "status.", ""]) {
    const fields = formFields(page.body, "/campaigns/new");
    fields.set("name", "N");
    fields.set("subject", "S");
    fields.set("body", "B");
    fields.set("audience", audience);
    const { res, body } = await post(env, "/campaigns/new", fields, { cookie: page.cookie, token: page.token });
    assert.equal(res.status, 422, audience);
    assert.match(body, /id="campaign-audience-error"/, audience);
  }
});

test("a service refusal lands on its field: a button with no address", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const page = await load(env, "/campaigns/new");
  const fields = formFields(page.body, "/campaigns/new");
  fields.set("name", "N");
  fields.set("audience", "status.contact");
  fields.set("subject", "S");
  fields.set("body", "B");
  fields.set("button_label", "RSVP");
  const { res, body } = await post(env, "/campaigns/new", fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 422);
  assert.match(body, /A button needs both a label and an address, or neither\./);
  assert.match(body, /value="RSVP"/);
  assert.match(body, /href="#campaign-button_label"/);
});

test("Edit shows the stored values and sends only what changed", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db);
  const page = await load(env, `/campaigns/${id}/edit`);
  assert.equal(page.res.status, 200);
  assert.equal(h1Count(page.body), 1);
  assert.match(page.body, /<option value="status\.contact" selected>Contact<\/option>/);
  assert.match(page.body, /value="Autumn news"/);
  const fields = formFields(page.body, `/campaigns/${id}/edit`);
  fields.set("subject", "A new subject");
  const before = await auditCount(db);
  const { res, location } = await post(env, `/campaigns/${id}/edit`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, new RegExp(`^/campaigns/${id}\\?change=chg_[a-z0-9]{12}$`));
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_campaign_draft");
  assert.match(audit?.summary ?? "", /^Changed campaign draft cp_[a-z0-9]+: subject \(change chg_/);
  assert.equal((await stepOf(db, id))?.subject, "A new subject");
  assert.equal((await campaignOf(db, id))?.name, "Autumn news");
});

test("choosing another audience sends the whole new audience; People I pick starts empty", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db);
  const page = await load(env, `/campaigns/${id}/edit`);
  const options = { cookie: page.cookie, token: page.token };
  const toView = formFields(page.body, `/campaigns/${id}/edit`);
  toView.set("audience", "view.vw_folks");
  const viewed = await post(env, `/campaigns/${id}/edit`, toView, options);
  assert.equal(viewed.res.status, 303);
  assert.match(viewed.location, new RegExp(`^/campaigns/${id}\\?change=`));
  assert.equal((await campaignOf(db, id))?.audience, '{"kind":"view","view":"vw_folks"}');

  const again = await load(env, `/campaigns/${id}/edit`);
  const toPeople = formFields(again.body, `/campaigns/${id}/edit`);
  toPeople.set("audience", "people");
  const picked = await post(env, `/campaigns/${id}/edit`, toPeople, { cookie: again.cookie, token: again.token });
  assert.equal(picked.res.status, 303);
  assert.equal((await campaignOf(db, id))?.audience, '{"kind":"people","people":[]}');
});

test("saving an edit with nothing changed, or a bad value, is a 422 that writes nothing", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db);
  const page = await load(env, `/campaigns/${id}/edit`);
  const options = { cookie: page.cookie, token: page.token };
  const before = await auditCount(db);
  const same = await post(env, `/campaigns/${id}/edit`, formFields(page.body, `/campaigns/${id}/edit`), options);
  assert.equal(same.res.status, 422);
  assert.match(same.body, /Nothing to save/);
  const bad = formFields(page.body, `/campaigns/${id}/edit`);
  bad.set("subject", "");
  const refused = await post(env, `/campaigns/${id}/edit`, bad, options);
  assert.equal(refused.res.status, 422);
  assert.match(refused.body, /id="campaign-subject-error"/);
  assert.equal(await auditCount(db), before);
});

test("Edit is a 404 for a campaign that is not a draft, is archived or is not there, for GET and POST", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const sent = await draft(db);
  const archived = await draft(db);
  db.exec(`UPDATE campaigns SET status = 'sent' WHERE id = '${sent}'; UPDATE campaigns SET archived = 1 WHERE id = '${archived}'`);
  const before = await auditCount(db);
  for (const id of [sent, archived, "cp_missing", "not-an-id"]) {
    assert.equal((await load(env, `/campaigns/${id}/edit`)).res.status, 404, id);
    assert.equal((await post(env, `/campaigns/${id}/edit`, { name: "Changed" })).res.status, 404, id);
  }
  assert.equal(await auditCount(db), before);
});

test("the picker is a 404 unless the campaign is a draft sent to people I pick", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const byStatus = await draft(db);
  const sent = await draft(db, { kind: "people", people: [] });
  db.exec(`UPDATE campaigns SET status = 'sent' WHERE id = '${sent}'`);
  for (const id of [byStatus, sent, "cp_missing"]) {
    assert.equal((await load(env, `/campaigns/${id}/people`)).res.status, 404, id);
    assert.equal((await post(env, `/campaigns/${id}/people/add`, { person: "ct_zed" })).res.status, 404, id);
    assert.equal((await post(env, `/campaigns/${id}/people/remove`, { person: "ct_zed" })).res.status, 404, id);
  }
});

test("the picker finds people by name, leaves out archived and picked ones, and labels outside names", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db, { kind: "people", people: ["ct_amy"] });
  const all = await load(env, `/campaigns/${id}/people`);
  assert.equal(all.res.status, 200);
  assert.equal(h1Count(all.body), 1);
  assert.match(all.body, /<h1>Pick people<\/h1>/);
  assert.match(all.body, /<form [^>]*action="\/campaigns\/cp_[a-z0-9]+\/people" method="get"/);
  assert.match(all.body, /<label for="[^"]*">Find people<\/label>/);
  assert.match(all.body, /<input id="people-person-ct_zed" name="person" type="checkbox" value="ct_zed">/);
  assert.doesNotMatch(all.body, /value="ct_old"/);
  assert.doesNotMatch(all.body, /type="checkbox" value="ct_amy"/);
  assert.match(all.body, /Already picked/);
  assert.match(all.body, /<span class="outside">From outside<\/span> <span class="outside-value">Ignore everything<\/span>/);
  assert.match(all.body, /Picked \(1\)/);

  const found = await load(env, `/campaigns/${id}/people?q=bakery`);
  assert.match(found.body, /value="ct_zed"/);
  assert.doesNotMatch(found.body, /value="ct_out"/);
  const none = await load(env, `/campaigns/${id}/people?q=nobody-by-this-name`);
  assert.doesNotMatch(none.body, /type="checkbox"/);
  assert.match(none.body, /No one matches/);
});

test("Add selected adds the ticked people in order, once each, and keeps the search", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db, { kind: "people", people: ["ct_amy"] });
  const page = await load(env, `/campaigns/${id}/people?q=example`);
  const fields = new URLSearchParams([["person", "ct_zed"], ["person", "ct_amy"], ["person", "ct_seed01"], ["q", "example"]]);
  const before = await auditCount(db);
  const { res, location } = await post(env, `/campaigns/${id}/people/add`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, new RegExp(`^/campaigns/${id}/people\\?q=example&change=chg_[a-z0-9]{12}$`));
  assert.deepEqual(await pickedOf(db, id), ["ct_amy", "ct_zed", "ct_seed01"]);
  assert.equal(await auditCount(db), before + 1);
  const audit = await auditOf(db, changeIdOf(location));
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.tool, "update_campaign_draft");
  const after = await load(env, location, page.cookie);
  assert.match(after.body, /Picked \(3\)/);
});

test("adding no one, or an unknown person, is a 422 and writes nothing", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db, { kind: "people", people: [] });
  const page = await load(env, `/campaigns/${id}/people`);
  const options = { cookie: page.cookie, token: page.token };
  const before = await auditCount(db);
  const empty = await post(env, `/campaigns/${id}/people/add`, {}, options);
  assert.equal(empty.res.status, 422);
  assert.match(empty.body, /Tick at least one person/);
  const bad = await post(env, `/campaigns/${id}/people/add`, { person: "ct_old" }, options);
  assert.equal(bad.res.status, 422);
  assert.match(bad.body, /ct_old/);
  assert.equal(await auditCount(db), before);
});

test("adding past 500 people is refused plainly", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const ids = Array.from({ length: 500 }, (_, i) => `ct_bulk${i}`);
  db.exec(ids.map((cid) => `INSERT INTO contacts (id, name) VALUES ('${cid}', 'Bulk ${cid}')`).join(";\n"));
  const id = await draft(db, { kind: "people", people: ids });
  const page = await load(env, `/campaigns/${id}/people`);
  const before = await auditCount(db);
  const { res, body } = await post(env, `/campaigns/${id}/people/add`, { person: "ct_zed" }, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 422);
  assert.match(body, /at most 500 people/);
  assert.equal((await pickedOf(db, id)).length, 500);
  assert.equal(await auditCount(db), before);
});

test("Remove takes one person off the list, each with its own plain form", async () => {
  const db = await campaignsDb();
  const env = devEnv(db);
  const id = await draft(db, { kind: "people", people: ["ct_amy", "ct_zed"] });
  const page = await load(env, `/campaigns/${id}/people`);
  assert.match(page.body, new RegExp(`action="/campaigns/${id}/people/remove"`));
  assert.equal([...page.body.matchAll(/action="\/campaigns\/cp_[a-z0-9]+\/people\/remove"/g)].length, 2);
  const fields = formFields(page.body, `/campaigns/${id}/people/remove`);
  assert.equal(fields.get("person"), "ct_amy");
  const { res, location } = await post(env, `/campaigns/${id}/people/remove`, fields, { cookie: page.cookie, token: page.token });
  assert.equal(res.status, 303);
  assert.match(location, new RegExp(`^/campaigns/${id}/people\\?change=chg_`));
  assert.deepEqual(await pickedOf(db, id), ["ct_zed"]);
  assert.equal((await auditOf(db, changeIdOf(location)))?.tool, "update_campaign_draft");
});
