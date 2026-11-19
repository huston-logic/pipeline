// The board and its JSON API end to end: `wrangler dev --local` with real local D1 and the fake seed, signed in by the
// local dev sign-in (decision 0013). The last test drives the board's write path (decisions 0014, 0017) like a browser.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { connectHttp, ok } from "../helpers/mcp-client.ts";
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

test("a move from the board: cookie and token from the page, 303 with the change, in /changes and recent_changes, then Undo", async () => {
  const page = await fetch(`${server.url}/pipeline`);
  assert.equal(page.status, 200);
  const cookie = (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^pipeline-csrf=[A-Za-z0-9_-]{43}$/);
  const html = await page.text();
  const token = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(html)?.[1] ?? "";
  assert.equal(`pipeline-csrf=${token}`, cookie, "the page's forms carry the cookie's token");
  // The first card in the first column that has one, and the next open stage after its own.
  const card = /<li class="card deal-card" data-deal="(dl_[a-z0-9]+)" data-stage="([a-z_]+)">/.exec(html);
  const dealId = card?.[1] ?? "";
  const from = card?.[2] ?? "";
  const stages = [...html.matchAll(/<section class="column" aria-labelledby="stage-\d+" data-drop-stage="([a-z_]+)">/g)].map((m) => m[1]);
  const to = stages[stages.indexOf(from) + 1] ?? "";
  assert.ok(dealId && from && to, "a deal with an open stage after its own");

  const postForm = (path: string, fields: Record<string, string>) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { Origin: server.url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: token, return_to: "/pipeline", ...fields }).toString(),
      redirect: "manual",
    });

  const moved = await postForm(`/deals/${dealId}/move`, { stage: to });
  assert.equal(moved.status, 303);
  const location = moved.headers.get("Location") ?? "";
  const changeId = /change=(chg_[a-z0-9]+)/.exec(location)?.[1] ?? "";
  assert.match(location, /^\/pipeline\?change=chg_[a-z0-9]{12}$/);

  const shown = await (await fetch(`${server.url}${location}`, { headers: { Cookie: cookie } })).text();
  assert.match(shown, new RegExp(`<div class="banner" role="status">\\n<p class="banner-text">Moved [^<]+\\(change ${changeId}\\)</p>`));
  assert.match(shown, new RegExp(`data-deal="${dealId}" data-stage="${to}"`), "the card is in its new column");

  const changes = await (await fetch(`${server.url}/changes`, { headers: { Cookie: cookie } })).text();
  assert.match(changes, new RegExp(`<dt>By</dt><dd>You, on the board</dd></div><div><dt>Change id</dt><dd>${changeId}</dd>`));

  const client: Client = await connectHttp(`${server.url}/mcp`);
  try {
    const recent = (await ok(client, "recent_changes")).data as { changes: { changeId: string; actor: string; tool: string }[] };
    assert.deepEqual(
      recent.changes.filter((change) => change.changeId === changeId).map((change) => [change.actor, change.tool]),
      [["owner", "update_deal"]],
    );

    const undone = await postForm(`/changes/${changeId}/undo`, {});
    assert.equal(undone.status, 303);
    const after = await (await fetch(`${server.url}${undone.headers.get("Location") ?? ""}`, { headers: { Cookie: cookie } })).text();
    assert.match(after, new RegExp(`<p class="banner-text">Undid ${changeId}: `));
    const deal = (await ok(client, "get_deal", { deal: dealId })).data as { stage: { key: string } };
    assert.equal(deal.stage.key, from, "the deal is back where it was");
  } finally {
    await client.close();
  }
});
