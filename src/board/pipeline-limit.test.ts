// The pipeline's per-stage limits on a big copy (decision 0020): the board and the list show the 50 deals longest in
// each stage and link to that stage's own list, which shows up to 200.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { STAGE_CARD_LIMIT, STAGE_LIST_LIMIT } from "./pages/pipeline.ts";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/**
 * `counts` open deals per stage. Ids run the other way from stage_entered_at: the highest id entered first, so the
 * deals longest in a stage are the ones with the highest ids, and id order alone would pick the wrong 50.
 */
async function pipelineDb(counts: Record<string, number>): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec("INSERT INTO contacts (id, name) VALUES ('ct_many', 'Pat Example')");
  const rows: string[] = [];
  for (const [stage, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      const entered = new Date(Date.UTC(2026, 0, 1, 0, n - 1 - i)).toISOString();
      rows.push(`('dl_${stage.replace("_", "")}${String(i).padStart(3, "0")}', 'ct_many', 'Deal ${i}', '${stage}', '${entered}')`);
    }
  }
  db.exec(`INSERT INTO deals (id, contact_id, title, stage_key, stage_entered_at) VALUES ${rows.join(", ")}`);
  return db;
}

async function mainOf(db: SqliteD1, path: string): Promise<{ status: number; title: string; main: string }> {
  const env: Env = { ENVIRONMENT: "development", AUTH_MODE: "dev", DB: db, ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  const res = await worker.fetch(new Request(`http://localhost:4821${path}`), env, ctx);
  const body = await res.text();
  return {
    status: res.status,
    title: /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "",
    main: /<main id="main">([\s\S]*)<\/main>/.exec(body)?.[1] ?? "",
  };
}

const dealIds = (markup: string) => [...markup.matchAll(/<a href="\/deals\/(dl_[a-z0-9]+)">/g)].map((m) => m[1]);
const section = (main: string, id: string) => new RegExp(`<section class="(?:column|stage)" aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(main)?.[0] ?? "";

test("the limits are 50 cards per stage and 200 rows in one stage's list", () => {
  assert.equal(STAGE_CARD_LIMIT, 50);
  assert.equal(STAGE_LIST_LIMIT, 200);
});

test("a board column shows the 50 deals longest in the stage, its full count, and a link to all of them", async () => {
  const db = await pipelineDb({ replied: 60, call_done: 50 });
  const { main } = await mainOf(db, "/pipeline");
  const replied = section(main, "stage-2");
  assert.match(replied, /<p class="stage-count">60 deals<\/p>/);
  // Longest in the stage first: dl_replied059 entered first, then 058, ... down to 010.
  assert.deepEqual(dealIds(replied), Array.from({ length: 50 }, (_, i) => `dl_replied${String(59 - i).padStart(3, "0")}`));
  assert.match(
    replied,
    /<p class="stage-more">Showing 50 of 60, longest in this stage first\. <a href="\/pipeline\?view=list&amp;stage=replied">Show all 60 in Replied<\/a><\/p>/,
  );
  const full = section(main, "stage-4");
  assert.equal(dealIds(full).length, 50);
  assert.doesNotMatch(full, /stage-more/, "a stage at the limit needs no link");
  assert.match(main, /<span class="stage-jump-count">60<\/span>/, "the jump list counts every deal");
});

test("the list view has the same limit and link per stage", async () => {
  const db = await pipelineDb({ new_inquiry: 3, replied: 75 });
  const { main } = await mainOf(db, "/pipeline?view=list");
  assert.equal(dealIds(section(main, "stage-2")).length, 50);
  assert.match(section(main, "stage-2"), /<a href="\/pipeline\?view=list&amp;stage=replied">Show all 75 in Replied<\/a>/);
  assert.equal(dealIds(section(main, "stage-1")).length, 3);
  assert.doesNotMatch(section(main, "stage-1"), /stage-more/);
});

test("one stage's list shows only that stage, up to 200 deals, with a way back to every stage", async () => {
  const db = await pipelineDb({ new_inquiry: 2, replied: 205 });
  const { status, title, main } = await mainOf(db, "/pipeline?view=list&stage=replied");
  assert.equal(status, 200);
  assert.equal(title, "Replied deals · Pipeline");
  assert.equal(main.match(/<section class="stage"/g)?.length, 1);
  assert.match(main, /<h2 id="stage-2">Replied<\/h2>\n<p class="stage-count">205 deals<\/p>/);
  assert.equal(dealIds(main).length, 200);
  assert.match(main, /<p class="stage-more">Showing 200 of 205, longest in this stage first\.<\/p>/);
  assert.match(main, /<p class="search-clear"><a href="\/pipeline\?view=list">Show every stage<\/a><\/p>/);
  assert.match(main, /name="return_to" value="\/pipeline\?view=list&amp;stage=replied"/, "a move comes back to this list");
  assert.match(main, /<a href="\/pipeline\?view=list" aria-current="page">List<\/a>/);
});

test("a stage that is unknown, closed or given to the board view is ignored", async () => {
  const db = await pipelineDb({ new_inquiry: 2, replied: 3 });
  for (const path of ["/pipeline?view=list&stage=nope", "/pipeline?view=list&stage=won"]) {
    const { title, main } = await mainOf(db, path);
    assert.equal(title, "Pipeline list · Pipeline", path);
    assert.equal(main.match(/<section class="stage"/g)?.length, 5, path);
  }
  const board = await mainOf(db, "/pipeline?stage=replied");
  assert.equal(board.title, "Pipeline · Pipeline");
  assert.equal(board.main.match(/<section class="column"/g)?.length, 5);
});
