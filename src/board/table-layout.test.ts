// The table layout (decision 0043): every people list and the Pipeline's List can show as cards or as a real table
// (caption, column headers that sort, the first cell of a row its header), with no JavaScript.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import type { Ctx } from "../services/change.ts";
import { personSql } from "../../tests/helpers/people.ts";
import { addField } from "../services/fields.ts";
import { addView } from "../services/views.ts";
import { DEFAULT_TZ } from "../time.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function seededDb(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(new Date(), DEFAULT_TZ));
  db.exec(`UPDATE contacts SET person_status = 'partner' WHERE id IN ('ct_seed01', 'ct_seed02')`);
  return db;
}

const env = (db: SqliteD1): Env => ({
  ENVIRONMENT: "development",
  AUTH_MODE: "dev",
  DB: db,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
});

async function get(db: SqliteD1, path: string) {
  const res = await worker.fetch(new Request(`http://localhost:4821${path}`), env(db), ctx);
  return { status: res.status, body: await res.text() };
}

const owner = (db: SqliteD1, tool: string): Ctx => ({ db, now: new Date(), actor: "owner", tool });
const mainOf = (body: string) => /<main id="main">([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
const tableOf = (main: string) => /<table class="data-table">[\s\S]*?<\/table>/.exec(main)?.[0] ?? "";
// A header's visible label: the text between its tags, less the sort arrow. Split, not replaced, so no tag can be
// rebuilt from the pieces (CodeQL js/incomplete-multi-character-sanitization).
const SORT_ARROWS = new Set(["&uarr;", "&darr;"]);
const headers = (table: string) =>
  [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    (m[1] ?? "")
      .split(/<[^>]*>/)
      .filter((piece) => !SORT_ARROWS.has(piece))
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
  );
const rowHeads = (table: string) => [...table.matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map((m) => m[1] ?? "");
const switchOf = (main: string) => /<ul class="view-switch layout-switch" aria-label="Show as">[\s\S]*?<\/ul>/.exec(main)?.[0] ?? "";

test("a status view as a table: a region wrapper, a caption, scoped headers, the person link in each row's header cell", async () => {
  const db = await seededDb();
  const { status, body } = await get(db, "/people?status=partner&layout=table");
  assert.equal(status, 200);
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  const main = mainOf(body);
  assert.match(main, /<div class="table-scroll" role="region" aria-label="Partner, as a table" tabindex="0">\n<table class="data-table">\n<caption class="visually-hidden">Partner: 2 people, by name, A to Z\.<\/caption>/);
  const table = tableOf(main);
  assert.deepEqual(headers(table), ["Name", "Company", "Person status", "Sub-status", "Next task", "Last activity"]);
  const heads = rowHeads(table);
  assert.equal(heads.length, 2);
  assert.match(heads[0] ?? "", /^<a href="\/contacts\/ct_seed01">Pat Example<\/a>$/);
  assert.equal(main.match(/<li class="card">/g), null, "no cards in the table layout");
  assert.doesNotMatch(body, /<script/, "no JavaScript");
  assert.doesNotMatch(body, /\sstyle=/i);
  assert.match(titleOf(body), /^Partner as a table · /);
});

test("sortable headers are links that keep every other parameter; the current one has aria-sort and an arrow", async () => {
  const db = await seededDb();
  const { body } = await get(db, "/people?status=partner&layout=table");
  const table = tableOf(mainOf(body));
  assert.match(table, /<th scope="col" aria-sort="ascending"><a href="\/people\?status=partner&amp;layout=table&amp;sort=name-desc">Name <span aria-hidden="true">&uarr;<\/span><\/a><\/th>/);
  assert.match(table, /<th scope="col"><a href="\/people\?status=partner&amp;layout=table&amp;sort=business-asc">Company<\/a><\/th>/);
  assert.match(table, /<th scope="col"><a href="\/people\?status=partner&amp;layout=table&amp;sort=next_task-asc">Next task<\/a><\/th>/);
  assert.match(table, /<th scope="col"><a href="\/people\?status=partner&amp;layout=table&amp;sort=last_activity-desc">Last activity<\/a><\/th>/);
  assert.match(table, /<th scope="col">Person status<\/th>/, "a column with no sort is not a link");

  const desc = tableOf(mainOf((await get(db, "/people?status=partner&layout=table&sort=name-desc&change=chg_x")).body));
  assert.match(desc, /<th scope="col" aria-sort="descending"><a href="\/people\?status=partner&amp;layout=table&amp;sort=name-asc">Name <span aria-hidden="true">&darr;<\/span><\/a><\/th>/);
  assert.deepEqual(rowHeads(desc).map((h) => /ct_seed0\d/.exec(h)?.[0]), ["ct_seed02", "ct_seed01"], "Z to A: Robin before Pat");
});

test("an unknown sort or layout falls back to the defaults, with no error", async () => {
  const db = await seededDb();
  for (const path of ["/people?status=partner&layout=table&sort=nonsense", "/people?status=partner&layout=table&sort=name-sideways", "/people?status=partner&layout=table&sort=__proto__-asc"]) {
    const { status, body } = await get(db, path);
    assert.equal(status, 200, path);
    assert.match(tableOf(mainOf(body)), /aria-sort="ascending"><a href="[^"]*">Name /, path);
  }
  const odd = await get(db, "/people?status=partner&layout=sideways");
  assert.equal(odd.status, 200);
  assert.match(mainOf(odd.body), /<li class="card">/, "a layout that is neither is the page's own");
});

test("the Show as switch is a labelled list of two links, the shown one aria-current, keeping the other parameters", async () => {
  const db = await seededDb();
  const table = switchOf(mainOf((await get(db, "/people?status=partner&layout=table&sort=name-desc")).body));
  assert.match(table, /<li><a href="\/people\?status=partner&amp;layout=cards&amp;sort=name-desc">Cards<\/a><\/li>/);
  assert.match(table, /<li><a href="\/people\?status=partner&amp;layout=table&amp;sort=name-desc" aria-current="page">Table<\/a><\/li>/);
  const cards = switchOf(mainOf((await get(db, "/people?status=partner")).body));
  assert.match(cards, /<li><a href="\/people\?status=partner&amp;layout=cards" aria-current="page">Cards<\/a><\/li>/);
  assert.match(cards, /<li><a href="\/people\?status=partner&amp;layout=table">Table<\/a><\/li>/);
});

test("a saved view's stored layout and columns decide the table; layout in the address overrides them for the visit and writes nothing", async () => {
  const db = await seededDb();
  await addField(owner(db, "add_field"), { entity: "contact", label: "Project type", type: "text" });
  db.exec(`UPDATE contacts SET fields = '{"project_type":"Commercial"}' WHERE id = 'ct_seed01';
    UPDATE contacts SET fields = '{"project_type":"Web page"}', untrusted_fields = '["name","email","business","fields.project_type"]' WHERE id = 'ct_seed02'`);
  const { viewId } = await addView(owner(db, "add_view"), {
    name: "Partner list",
    module: "people",
    filters: { personStatus: "partner" },
    layout: "table",
    columns: ["name", "email", "source", "fields.project_type", "created"],
  });
  const path = `/people?view=${viewId}`;
  const stored = await get(db, path);
  const table = tableOf(mainOf(stored.body));
  assert.deepEqual(headers(table), ["Name", "Email", "Source", "Project type", "Added"]);
  assert.match(table, /<td>Commercial<\/td>/);
  assert.match(table, /<td><span class="outside">From outside<\/span> <span class="outside-value">Web page<\/span><\/td>/, "an outside custom field value is labelled");
  assert.doesNotMatch(table, /<a href="[^"]*">Project type/, "a custom field column has no sort");
  assert.match(titleOf(stored.body), /^Partner list as a table · /);

  const snapshot = async () => ({
    changes: await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>(),
    view: await db.prepare("SELECT * FROM views WHERE id = ?").bind(viewId).first(),
  });
  const before = await snapshot();
  const cards = await get(db, `${path}&layout=cards`);
  assert.match(mainOf(cards.body), /<li class="card">/);
  assert.equal(tableOf(mainOf(cards.body)), "");
  assert.doesNotMatch(titleOf(cards.body), /table/);
  await get(db, `${path}&layout=table&sort=created-asc`);
  assert.deepEqual(await snapshot(), before, "a GET never writes");
  assert.match(switchOf(mainOf(stored.body)), /<li><a href="\/people\?view=vw_[a-z2-7]{12}&amp;layout=cards">Cards<\/a><\/li>/);
});

test("outside text in a table is labelled and never a link's text", async () => {
  const db = await seededDb();
  const { body } = await get(db, "/people?status=partner&layout=table");
  const table = tableOf(mainOf(body));
  assert.match(
    table,
    /<th scope="row"><a href="\/contacts\/ct_seed02">Contact ct_seed02<\/a> <span class="outside">From outside<\/span> <span class="outside-value">Robin Sample<\/span><\/th>/,
  );
  assert.match(table, /<td><span class="outside">From outside<\/span> <span class="outside-value">Sample Bakery<\/span><\/td>/);
  const linkTexts = [...body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1] ?? "");
  assert.ok(!linkTexts.some((text) => text.includes("Robin") || text.includes("Bakery")));
});

test("a table shows at most 200 rows and says how many there are", async () => {
  const db = await seededDb();
  const rows = Array.from({ length: 205 }, (_, i) => `('ct_bulk${i}', 'Bulk Person ${i}', 'bulk${i}@example.com', 'partner')`);
  db.exec(`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")}`);
  const main = mainOf((await get(db, "/people?status=partner&layout=table")).body);
  assert.match(main, /Showing the first 200 of 207 people, in this view&#39;s order\./);
  assert.equal(rowHeads(tableOf(main)).length, 200);
});

test("Contacts as a table: its own columns, sort links that keep the search, and the search form keeps the layout", async () => {
  const db = await seededDb();
  const { body } = await get(db, "/contacts?layout=table&q=example");
  const main = mainOf(body);
  const table = tableOf(main);
  assert.deepEqual(headers(table), ["Name", "Company", "Open deals", "Last activity"]);
  assert.match(table, /<th scope="col" aria-sort="ascending"><a href="\/contacts\?layout=table&amp;q=example&amp;sort=name-desc">Name /);
  assert.match(table, /<th scope="col"><a href="\/contacts\?layout=table&amp;q=example&amp;sort=company-asc">Company<\/a><\/th>/);
  assert.match(table, /<th scope="col"><a href="\/contacts\?layout=table&amp;q=example&amp;sort=deals-desc">Open deals<\/a><\/th>/);
  assert.match(main, /<input type="hidden" name="layout" value="table">/);
  assert.match(table, /<th scope="row"><a href="\/contacts\/ct_seed01">Pat Example<\/a><\/th>/);
  assert.match(main, /aria-label="Show as"/);
  const sorted = await get(db, "/contacts?layout=table&sort=company-desc");
  assert.match(tableOf(mainOf(sorted.body)), /<th scope="col" aria-sort="descending"><a href="\/contacts\?layout=table&amp;sort=company-asc">Company /);
  assert.equal((await get(db, "/contacts?layout=table&sort=bogus")).status, 200);
});

test("Leads as a table: Status, Last contact and Next task columns; the sort links keep the status and the source", async () => {
  const db = await seededDb();
  db.exec(`INSERT INTO contacts (id, name, email, untrusted_fields, lead_status, lead_status_at, person_status, sub_status)
    VALUES ('ct_lead01', 'Imani Okoye', 'imani.okoye@example.org', '[]', 'new', '2026-01-01T00:00:00.000Z', ${personSql("new")})`);
  const { body } = await get(db, "/leads?layout=table&status=new");
  const main = mainOf(body);
  const table = tableOf(main);
  assert.deepEqual(headers(table), ["Name", "Company", "Status", "Last contact", "Next task", "Added"]);
  assert.match(table, /<th scope="col" aria-sort="ascending"><a href="\/leads\?layout=table&amp;status=new&amp;sort=next_task">Next task /);
  assert.match(table, /<th scope="col"><a href="\/leads\?layout=table&amp;status=new&amp;sort=last_contact">Last contact<\/a><\/th>/);
  assert.match(table, /<th scope="row"><a href="\/contacts\/ct_lead01">Imani Okoye<\/a><\/th>/);
  assert.match(main, /<input type="hidden" name="layout" value="table">/);
});

test("the Pipeline List is a table by default (not the Board's cards), with its sort links; layout=cards shows cards", async () => {
  const db = await seededDb();
  const { status, body } = await get(db, "/pipeline?view=list");
  assert.equal(status, 200);
  const main = mainOf(body);
  assert.equal(titleOf(body), "Pipeline list · Pipeline");
  const table = tableOf(main);
  assert.match(main, /<div class="table-scroll" role="region" aria-label="Open deals, as a table" tabindex="0">/);
  assert.deepEqual(headers(table), ["Deal", "Person", "Stage", "Value", "Next step", "Days in stage"]);
  assert.equal(rowHeads(table).length, 6);
  assert.match(rowHeads(table).join("\n"), /<a href="\/deals\/dl_seed01">Website refresh for Example Plumbing<\/a>/);
  assert.match(table, /<td><a href="\/contacts\/ct_seed01">Pat Example<\/a><\/td>/);
  assert.match(table, /<td>1,500<\/td>/);
  assert.match(table, /<td>Discovery call<\/td>/);
  assert.match(table, /<th scope="col" aria-sort="descending"><a href="\/pipeline\?view=list&amp;sort=days_in_stage-asc">Days in stage /);
  assert.match(table, /<th scope="col"><a href="\/pipeline\?view=list&amp;sort=value-desc">Value<\/a><\/th>/);
  assert.doesNotMatch(main, /deal-row|class="stage"|name="return_to"/, "no grouped rows and no move forms: it is a table");
  assert.match(switchOf(main), /<a href="\/pipeline\?view=list&amp;layout=cards">Cards<\/a>/);
  assert.match(switchOf(main), /<a href="\/pipeline\?view=list&amp;layout=table" aria-current="page">Table<\/a>/);
  assert.match(main, /<a href="\/pipeline\?view=list" aria-current="page">List<\/a>/, "List is current in the Pipeline's switch");
  assert.match(main, /<span class="closed-label">Won<\/span>/, "the closed counts stay under the list");

  const cards = mainOf((await get(db, "/pipeline?view=list&layout=cards")).body);
  assert.equal(tableOf(cards), "");
  assert.equal(cards.match(/<li class="card">/g)?.length, 6);
});

test("the Pipeline List sorts by value, and an outside deal title is labelled in its row header", async () => {
  const db = await seededDb();
  const table = tableOf(mainOf((await get(db, "/pipeline?view=list&sort=value-desc")).body));
  assert.match(table, /<th scope="col" aria-sort="descending"><a href="\/pipeline\?view=list&amp;sort=value-asc">Value /);
  assert.match(
    table,
    /<th scope="row"><a href="\/deals\/dl_seed02">Deal dl_seed02<\/a> <span class="outside">From outside<\/span> <span class="outside-value">New website for Sample Bakery<\/span><\/th>/,
  );
  assert.match(table, /<td><a href="\/contacts\/ct_seed01">Pat Example<\/a><\/td>/);
});

test("one stage's list is a table of that stage, up to 200 deals, with a way back to every stage", async () => {
  const db = await seededDb();
  const rows = Array.from({ length: 205 }, (_, i) => `('dl_bulk${i}', 'ct_seed01', 'Bulk deal ${i}', 'replied', '2026-01-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ${rows.join(", ")}`);
  const { body } = await get(db, "/pipeline?view=list&stage=replied");
  const main = mainOf(body);
  assert.equal(titleOf(body), "Replied deals · Pipeline");
  assert.equal(rowHeads(tableOf(main)).length, 200);
  assert.match(main, /Showing the first 200 of 206 deals, in this view&#39;s order\./);
  assert.match(main, /<p class="search-clear"><a href="\/pipeline\?view=list">Show every stage<\/a><\/p>/);
  assert.match(tableOf(main), /sort=days_in_stage-asc&amp;stage=replied|stage=replied&amp;sort=days_in_stage-asc/);
  for (const stage of ["nope", "won"]) {
    const ignored = await get(db, `/pipeline?view=list&stage=${stage}`);
    assert.equal(titleOf(ignored.body), "Pipeline list · Pipeline", stage);
    assert.doesNotMatch(mainOf(ignored.body), /Show every stage/, stage);
  }
});

test("a saved deals view follows its stored layout, and the Board stays the kanban", async () => {
  const db = await seededDb();
  const { viewId } = await addView(owner(db, "add_view"), { name: "Biggest first", module: "deals", sort: "value", layout: "table", columns: ["deal", "stage", "next_date", "source"] });
  const { body } = await get(db, `/pipeline?view=${viewId}`);
  const table = tableOf(mainOf(body));
  assert.deepEqual(headers(table), ["Deal", "Stage", "Next date", "Source"]);
  assert.match(table, /<th scope="col"><a href="\/pipeline\?view=vw_[a-z2-7]{12}&amp;sort=next_date-asc">Next date<\/a><\/th>/);
  assert.match(table, /<th scope="col">Source<\/th>/, "Source is a person's field: it has no sort");
  assert.doesNotMatch(table, /aria-sort/, "the view is sorted by a column it does not show");
  assert.match(titleOf(body), /^Biggest first as a table · /);
  const board = mainOf((await get(db, "/pipeline")).body);
  assert.match(board, /class="board"/);
  assert.equal(tableOf(board), "");
  assert.doesNotMatch(board, /aria-label="Show as"/, "the Board has no layout switch");
});
