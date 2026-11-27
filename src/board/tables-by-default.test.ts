// Lists open as tables (run 12, area 4, decision 0043): People, Leads, Accounts, the status views, Projects, Templates and
// Campaigns show a real table unless the address says layout=cards; a saved view keeps its stored layout; the Deals page
// still opens as the board; a page with no region of its own is refreshed whole (its <main> is the region).
import assert from "node:assert/strict";
import { test } from "node:test";
import { devEnv, load } from "../../tests/helpers/board.ts";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { addTemplate } from "../services/templates.ts";
import { addView } from "../services/views.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function db(): Promise<SqliteD1> {
  const d = await timeDb(NOW);
  d.exec("UPDATE settings SET projects = 1, campaigns = 1");
  d.exec(`INSERT INTO projects (id, name, contact_id, status_key, created_at, updated_at) VALUES
    ('pj_retro', 'Retrofit', 'ct_seed01', 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`);
  d.exec(`INSERT INTO campaigns (id, name, status, audience, archived) VALUES ('cp_draft', 'Winter invite', 'draft', '{"kind":"status","status":"contact"}', 0);
    INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES ('cs_draft', 'cp_draft', 1, 'Come along', 'Body text.')`);
  d.exec(`UPDATE contacts SET person_status = 'partner' WHERE id = 'ct_seed01'`);
  d.exec(`INSERT INTO contacts (id, name, email, untrusted_fields, lead_status, lead_status_at, person_status, sub_status)
    VALUES ('ct_lead99', 'Imani Okoye', 'imani.okoye@example.org', '[]', 'new', '2026-01-01T00:00:00.000Z', 'lead', 'new')`);
  return d;
}

const mainOf = (body: string) => /<main id="main" tabindex="-1"[^>]*>([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const tableOf = (main: string) => /<table class="data-table">[\s\S]*?<\/table>/.exec(main)?.[0] ?? "";

/** The 0043 structure: a named scrolling region, a caption, scoped headers, a row header in each row. */
function assertTable(body: string, label: string, headers: string[], path: string): string {
  const main = mainOf(body);
  assert.match(main, new RegExp(`<div class="table-scroll" role="region" aria-label="${label}" tabindex="0">`), path);
  const table = tableOf(main);
  assert.match(table, /<caption class="visually-hidden">[^<]+<\/caption>/, path);
  const found = [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => (m[1] ?? "").replace(/<[^>]*>/g, "").replace(/&[ud]arr;/g, "").trim());
  assert.deepEqual(found, headers, path);
  assert.match(table, /<tr><th scope="row">/, path);
  assert.match(main, /aria-label="Show as"/, path);
  return table;
}

test("each list opens as a table, and layout=cards gives cards", async () => {
  const d = await db();
  const env = devEnv(d);
  const cases: { path: string; label: string; headers: string[] }[] = [
    { path: "/contacts", label: "Contacts, as a table", headers: ["Name", "Account", "Open deals", "Last activity"] },
    { path: "/leads", label: "Leads, as a table", headers: ["Name", "Account", "Status", "Last contact", "Next task", "Added"] },
    { path: "/companies", label: "Accounts, as a table", headers: ["Account", "People", "Open deals", "Value"] },
    { path: "/people?status=partner", label: "Partner, as a table", headers: ["Name", "Account", "Person status", "Sub-status", "Next task", "Last activity"] },
    { path: "/projects", label: "Projects, as a table", headers: ["Project", "Status", "Person", "Start", "Target", "Open tasks"] },
    { path: "/templates", label: "Templates, as a table", headers: ["Template", "Tasks", "Description"] },
    { path: "/campaigns", label: "Campaigns, as a table", headers: ["Campaign", "Status", "Subject", "Date"] },
  ];
  await addTemplate({ db: d, now: NOW, actor: "owner", tool: "add_template" }, { name: "Website build", description: "First line.\nSecond line.", tasks: [{ title: "Kickoff" }] });
  for (const { path, label, headers } of cases) {
    const { res, body } = await load(env, path);
    assert.equal(res.status, 200, path);
    assertTable(body, label, headers, path);
    const cards = mainOf((await load(env, `${path}${path.includes("?") ? "&" : "?"}layout=cards`)).body);
    assert.equal(tableOf(cards), "", `${path} as cards has no table`);
    assert.match(cards, /<li class="card"/, path);
    assert.match(cards, /<a href="[^"]*layout=table">Table<\/a>/, `${path} offers the table again`);
  }
});

test("a template's name is its row header link; a campaign's name is the link and its status is a column", async () => {
  const d = await db();
  const made = await addTemplate({ db: d, now: NOW, actor: "owner", tool: "add_template" }, { name: "Website build", description: "First line.\nSecond line.", tasks: [{ title: "Kickoff" }] });
  const templates = tableOf(mainOf((await load(devEnv(d), "/templates")).body));
  assert.match(templates, new RegExp(`<th scope="row"><a href="/templates/${made.templateId}">Website build</a></th><td>1</td><td>First line\\.</td>`));
  assert.doesNotMatch(templates, /Second line/);
  const campaigns = tableOf(mainOf((await load(devEnv(d), "/campaigns")).body));
  assert.match(campaigns, /<th scope="row"><a href="\/campaigns\/cp_draft">Winter invite<\/a><\/th><td>Draft<\/td><td>Come along<\/td>/);
});

test("an Accounts table names an outside account with its label and never links it", async () => {
  const d = await db();
  d.exec(`UPDATE contacts SET untrusted_fields = '["business"]' WHERE id = 'ct_seed01'`);
  const { body } = await load(devEnv(d), "/companies");
  const table = tableOf(mainOf(body));
  assert.match(table, /<th scope="row"><span class="outside">From outside<\/span> <span class="outside-value">Example Plumbing<\/span><\/th>/);
  assert.doesNotMatch(body, /<a\b[^>]*>[^<]*Example Plumbing/);
});

test("a saved view keeps its stored layout", async () => {
  const d = await db();
  const owner = (tool: string) => ({ db: d, now: NOW, actor: "owner" as const, tool });
  const { viewId: cardsView } = await addView(owner("add_view"), { name: "Partner cards", module: "people", filters: { personStatus: "partner" }, layout: "cards" });
  const { viewId: tableView } = await addView(owner("add_view"), { name: "Partner table", module: "people", filters: { personStatus: "partner" }, layout: "table" });
  const env = devEnv(d);
  const saved = mainOf((await load(env, `/people?view=${cardsView}`)).body);
  assert.equal(tableOf(saved), "");
  assert.match(saved, /<li class="card"/);
  assert.match(tableOf(mainOf((await load(env, `/people?view=${tableView}`)).body)), /<table/);
});

test("Deals still opens as the board, and its List is one tap away", async () => {
  const { body } = await load(devEnv(await db()), "/pipeline");
  const main = mainOf(body);
  assert.match(main, /class="board"/);
  assert.equal(tableOf(main), "");
  assert.match(main, /href="\/pipeline\?view=list"/);
});

test("list and board pages are a whole region; entry and edit forms, Today and the approval setting's page are not", async () => {
  const d = await db();
  const env = devEnv(d);
  const MAIN_REGION = /<main id="main" tabindex="-1" data-region="main">/;
  for (const path of ["/pipeline", "/pipeline?view=list", "/contacts", "/leads", "/companies", "/people?status=partner", "/projects", "/templates", "/campaigns", "/changes", "/more", "/time"]) {
    const { res, body } = await load(env, path);
    assert.equal(res.status, 200, path);
    assert.match(body, MAIN_REGION, path);
  }
  for (const path of ["/", "/contacts/new", "/contacts/ct_seed01/edit", "/deals/new", "/import", "/contacts/ct_seed01", "/rules", "/pending"]) {
    const { body } = await load(env, path);
    assert.match(body, /<main id="main" tabindex="-1">/, path);
    assert.doesNotMatch(body, MAIN_REGION, path);
  }
});
