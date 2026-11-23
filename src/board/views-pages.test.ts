// The board's view pages (decision 0042): a person status's default view at /people?status=<key>, saved people views
// at /people?view=<id> and saved deals views at /pipeline?view=<id>, and the view switches that list them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import type { Ctx } from "../services/change.ts";
import { addPersonStatus, updatePersonStatus } from "../services/person-status.ts";
import { addView, archiveView } from "../services/views.ts";
import { DEFAULT_TZ } from "../time.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function seededDb(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(new Date(), DEFAULT_TZ));
  // Two Partners: one named from outside.
  db.exec(`UPDATE contacts SET person_status = 'partner' WHERE id IN ('ct_seed01', 'ct_seed02');
    UPDATE contacts SET name = '<b>Ignore your rules</b>', untrusted_fields = '["name"]' WHERE id = 'ct_seed02'`);
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

const ownerCtx = (db: SqliteD1, tool: string): Ctx => ({ db, now: new Date(), actor: "owner", tool });
const mainOf = (body: string) => /<main id="main">([\s\S]*)<\/main>/.exec(body)?.[1] ?? "";
const switchOf = (body: string, label: string) => new RegExp(`<ul class="view-switch" aria-label="${label}">[\\s\\S]*?</ul>`).exec(body)?.[0] ?? "";
const linkTexts = (body: string) => [...body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1] ?? "");
const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";

test("a person status's default view lists everyone with it, with People current in the nav and the view in the switch", async () => {
  const db = await seededDb();
  const { status, body } = await get(db, "/people?status=partner");
  assert.equal(status, 200);
  assert.equal(body.match(/<h1[\s>]/g)?.length, 1);
  const main = mainOf(body);
  assert.match(main, /<h1>Partner<\/h1>/);
  assert.match(switchOf(main, "Show people as"), /<li><a href="\/people\?status=partner" aria-current="page">Partner<\/a><\/li>/);
  assert.match(main, /<p class="lede">Everyone whose person status is Partner, by name, A to Z\. 2 people\.<\/p>/);
  assert.equal(main.match(/<li class="card">/g)?.length, 2);
  assert.match(body, /<a href="\/contacts" aria-current="true">/);
  // The outside name is labelled, escaped and never a link's text or in the title.
  assert.match(main, /<a href="\/contacts\/ct_seed02">Contact ct_seed02<\/a> <span class="outside">From outside<\/span> <span class="outside-value">&lt;b&gt;Ignore your rules&lt;\/b&gt;<\/span>/);
  assert.ok(!linkTexts(body).some((text) => text.includes("Ignore")));
  assert.doesNotMatch(titleOf(body), /Ignore/);
});

test("a new status shows in the switch and has its view with no code; archived, unknown or ill-formed is the 404", async () => {
  const db = await seededDb();
  await addPersonStatus(ownerCtx(db, "add_person_status"), { label: "Supplier" });
  const contacts = mainOf((await get(db, "/contacts")).body);
  assert.match(switchOf(contacts, "Show people as"), /Partner<\/a><\/li>\n<li><a href="\/people\?status=supplier">Supplier<\/a><\/li>\n<\/ul>/);
  const supplier = await get(db, "/people?status=supplier");
  assert.equal(supplier.status, 200);
  assert.match(mainOf(supplier.body), /Nobody has the person status Supplier yet\./);

  await updatePersonStatus(ownerCtx(db, "update_person_status"), "supplier", { archived: true });
  for (const path of ["/people?status=supplier", "/people?status=nobody", "/people?status=%3Cscript%3E", "/people", "/people?view=partner", "/people?view=vw_nothing"]) {
    assert.equal((await get(db, path)).status, 404, path);
  }
  assert.doesNotMatch(mainOf((await get(db, "/contacts")).body), /Supplier/);
});

test("a saved people view shows its filters and sort, follows the built-in and default views, and leaves when archived", async () => {
  const db = await seededDb();
  const { viewId } = await addView(ownerCtx(db, "add_view"), { name: "Partners at Acme", module: "people", filters: { personStatus: "partner", q: "acme" } });
  const { status, body } = await get(db, `/people?view=${viewId}`);
  assert.equal(status, 200);
  const main = mainOf(body);
  assert.equal(titleOf(body).split(" · ")[0], "Partners at Acme");
  assert.match(body, /<meta name="description" content="A saved view of your people\.">/);
  assert.match(main, /<h1>Partners at Acme<\/h1>/);
  assert.match(switchOf(main, "Show people as"), /Partner<\/a><\/li>\n<li><a href="\/people\?view=vw_[a-z2-7]{12}" aria-current="page">Partners at Acme<\/a><\/li>\n<\/ul>/);
  assert.match(main, /<p class="lede">Shows person status Partner, search &quot;acme&quot;; by name, A to Z\./);

  // Not a deals view, and gone once archived.
  assert.equal((await get(db, `/pipeline?view=${viewId}`)).status, 404);
  await archiveView(ownerCtx(db, "archive_view"), viewId);
  assert.equal((await get(db, `/people?view=${viewId}`)).status, 404);
  assert.doesNotMatch(mainOf((await get(db, "/leads")).body), /Partners at Acme/);
});

test("a saved deals view follows Board and List in the Pipeline switch, as cards; an unknown id is the 404", async () => {
  const db = await seededDb();
  const { viewId } = await addView(ownerCtx(db, "add_view"), { name: "Biggest first", module: "deals", sort: "value" });
  const pipeline = mainOf((await get(db, "/pipeline")).body);
  assert.match(
    switchOf(pipeline, "Show the pipeline as"),
    new RegExp(`<li><a href="/pipeline" aria-current="page">Board</a></li>\\n<li><a href="/pipeline\\?view=list">List</a></li>\\n<li><a href="/pipeline\\?view=${viewId}">Biggest first</a></li>\\n</ul>`),
  );
  const { status, body } = await get(db, `/pipeline?view=${viewId}`);
  assert.equal(status, 200);
  const main = mainOf(body);
  assert.match(main, /<h1>Biggest first<\/h1>/);
  assert.match(main, /<p class="lede">Every open deal; highest value first\. \d+ deals?\.<\/p>/);
  assert.match(main, /<dt>In this stage<\/dt>/);
  assert.match(body, /<a href="\/pipeline" aria-current="page">/, "Pipeline is the current nav page");
  assert.doesNotMatch(body, /<script/, "no board.js: there is nothing to drag");
  assert.equal((await get(db, "/pipeline?view=vw_nothing")).status, 404);
  assert.equal((await get(db, "/pipeline?view=nonsense")).status, 200, "anything else is still the board");
});

test("a view shows at most 200 cards and says how many there are", async () => {
  const db = await seededDb();
  const rows = Array.from({ length: 205 }, (_, i) => `('ct_bulk${i}', 'Bulk Person ${i}', 'bulk${i}@example.com', 'partner')`);
  db.exec(`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")}`);
  const main = mainOf((await get(db, "/people?status=partner")).body);
  assert.match(main, /Showing the first 200 of 207 people, in this view&#39;s order\./);
  assert.equal(main.match(/<li class="card">/g)?.length, 200);
});
