// The board and its JSON API end to end: `wrangler dev --local` with real local D1 and the fake seed, signed in by the
// local dev sign-in (decision 0013).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { boardRoutes } from "../../src/board/routes.ts";
import { parseCsv } from "../../src/http/csv.ts";
import { EXPORT_TABLES } from "../../src/http/export.ts";
import { type DevServer, startDevServer } from "./harness.ts";

let server: DevServer;

before(async () => {
  server = await startDevServer();
});

after(async () => {
  await server?.stop();
});

test("every board page answers 200 with one <h1>, and an unknown deal is 404", async () => {
  for (const path of boardRoutes) {
    const res = await fetch(`${server.url}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal((await res.text()).match(/<h1[\s>]/g)?.length, 1, path);
  }
  const missing = await fetch(`${server.url}/deals/dl_nothing0000`);
  assert.equal(missing.status, 404);
  await missing.body?.cancel();
});

test("the JSON export holds every table, and an empty table's CSV still has its header", async () => {
  const res = await fetch(`${server.url}/api/export.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment; filename="pipeline-export-\d{4}-\d{2}-\d{2}\.json"$/);
  const body = (await res.json()) as { tables: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(body.tables), [...EXPORT_TABLES]);
  assert.deepEqual(body.tables.rule_firings, [], "no rule has fired on this server");

  // Real D1 gives the column names even for an empty result.
  const csv = await fetch(`${server.url}/api/export/rule_firings.csv`);
  assert.equal(csv.status, 200);
  assert.deepEqual(parseCsv(await csv.text()), [["id", "rule_id", "deal_id", "fire_key", "task_id", "fired_at"]]);

  const contacts = parseCsv(await (await fetch(`${server.url}/api/export/contacts.csv`)).text());
  assert.equal(contacts.length, (body.tables.contacts?.length ?? 0) + 1, "a header and every contact");
});
