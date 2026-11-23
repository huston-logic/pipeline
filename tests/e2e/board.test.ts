// The board and its JSON API end to end: `wrangler dev --local` with real local D1 and the fake seed, signed in by the
// local dev sign-in (decision 0013). The last test drives the board's write path (decisions 0014, 0017) like a browser.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import { formFields } from "../helpers/form-fields.ts";
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

test("the home-screen manifest is served signed in, and every icon it or the layout names is a PNG (decision 0019)", async () => {
  const res = await fetch(`${server.url}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/manifest+json");
  const manifest = (await res.json()) as { start_url: string; icons: { src: string; sizes: string }[] };
  assert.equal(manifest.start_url, "/");

  const page = await (await fetch(`${server.url}/`)).text();
  const linked = [...page.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.equal(linked.length, 2, "the favicon and the apple-touch icon");
  assert.match(page, /<link rel="manifest" href="\/manifest.webmanifest" crossorigin="use-credentials">/);

  for (const src of [...manifest.icons.map((icon) => icon.src), ...linked]) {
    const icon = await fetch(`${server.url}${src}`);
    assert.equal(icon.status, 200, src);
    assert.equal(icon.headers.get("Content-Type"), "image/png", src);
    const bytes = new Uint8Array(await icon.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], src);
  }
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
  assert.deepEqual(parseCsv(await csv.text()), [["id", "rule_id", "deal_id", "contact_id", "fire_key", "task_id", "fired_at"]]);

  const contacts = parseCsv(await (await fetch(`${server.url}/api/export/contacts.csv`)).text());
  assert.equal(contacts.length, (body.tables.contacts?.length ?? 0) + 1, "a header and every contact");
});

test("board edits (a contact's phone, a new task) show in /changes and recent_changes as the owner's, and Undo reverses them", async () => {
  const contactId = "ct_seed01";
  const editPath = `/contacts/${contactId}/edit`;
  const page = await fetch(`${server.url}${editPath}`);
  assert.equal(page.status, 200);
  const cookie = (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const fields = formFields(await page.text(), editPath);
  const token = fields.get("csrf") ?? "";
  assert.equal(`pipeline-csrf=${token}`, cookie);
  const send = (path: string, body: URLSearchParams) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { Origin: server.url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
  const changeOf = (res: Response) => /change=(chg_[a-z0-9]+)/.exec(res.headers.get("Location") ?? "")?.[1] ?? "";

  fields.set("phone", "555-0177");
  const edited = await send(editPath, fields);
  assert.equal(edited.status, 303);
  assert.match(edited.headers.get("Location") ?? "", new RegExp(`^/contacts/${contactId}\\?change=chg_[a-z0-9]{12}$`));
  const editId = changeOf(edited);

  const tasked = await send(`/contacts/${contactId}/tasks`, new URLSearchParams({ csrf: token, return_to: `/contacts/${contactId}`, title: "Call about the drawings", "due.date": "", "due.time": "" }));
  assert.equal(tasked.status, 303);
  const taskId = changeOf(tasked);

  const changes = await (await fetch(`${server.url}/changes`, { headers: { Cookie: cookie } })).text();
  for (const id of [editId, taskId]) {
    assert.match(changes, new RegExp(`<dt>By</dt><dd>You, on the board</dd></div><div><dt>Change id</dt><dd>${id}</dd>`), id);
  }

  const client: Client = await connectHttp(`${server.url}/mcp`);
  try {
    const recent = (await ok(client, "recent_changes")).data as { changes: { changeId: string; actor: string; tool: string }[] };
    const mine = (id: string) => recent.changes.filter((change) => change.changeId === id).map((change) => [change.actor, change.tool]);
    assert.deepEqual(mine(editId), [["owner", "update_contact"]]);
    assert.deepEqual(mine(taskId), [["owner", "add_task"]]);

    // Undo the task (it removes a record, so it is confirmed), then the edit (one click).
    const undoTask = await send(`/changes/${taskId}/undo`, new URLSearchParams({ csrf: token, return_to: "/changes", confirm: "yes" }));
    assert.equal(undoTask.status, 303);
    const undoEdit = await send(`/changes/${editId}/undo`, new URLSearchParams({ csrf: token, return_to: `/contacts/${contactId}` }));
    assert.equal(undoEdit.status, 303);
    const after = await (await fetch(`${server.url}${undoEdit.headers.get("Location") ?? ""}`, { headers: { Cookie: cookie } })).text();
    assert.match(after, new RegExp(`<p class="banner-text">Undid ${editId}: `));
    const contact = (await ok(client, "search_contacts", { query: "" })).data as { contacts: { id: string; phone: string | null }[] };
    assert.notEqual(contact.contacts.find((row) => row.id === contactId)?.phone, "555-0177", "the phone is back");
    const tasks = (await ok(client, "whats_due")).data as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(tasks), /Call about the drawings/, "the task is gone");
  } finally {
    await client.close();
  }
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

test("the board import (decision 0036): upload, match, check, apply and undo a 3-row file", async () => {
  const start = await fetch(`${server.url}/import?module=people`);
  assert.equal(start.status, 200);
  const cookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const token = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(await start.text())?.[1] ?? "";
  const headers = { Origin: server.url, Cookie: cookie };
  const get = async (path: string) => (await fetch(`${server.url}${path}`, { headers })).text();
  const postFields = (path: string, fields: URLSearchParams) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
      redirect: "manual",
    });

  const csv = [
    "Name,Email,Met at,Budget",
    "Ava Importer,ava.importer@example.net,the fair,500",
    "Ben Importer,ben.importer@example.net,,",
    "Cleo Importer,not-an-email,a referral,700",
  ].join("\r\n");
  const form = new FormData();
  form.set("csrf", token);
  form.set("return_to", "/import?module=people");
  form.set("module", "people");
  form.set("as", "contacts");
  form.set("file", new File([csv], "people.csv", { type: "text/csv" }));
  form.set("paste", "");
  const uploaded = await fetch(`${server.url}/import`, { method: "POST", headers, body: form, redirect: "manual" });
  assert.equal(uploaded.status, 303);
  const draft = uploaded.headers.get("Location") ?? "";
  assert.match(draft, /^\/import\/im_[a-z2-7]{12}$/);

  const fields = formFields(await get(draft), `${draft}/map`);
  fields.delete("as");
  fields.set("as", "contacts");
  fields.set("col.2", "notes");
  fields.set("col.3", "new_field");
  const mapped = await postFields(`${draft}/map`, fields);
  assert.equal(mapped.status, 303);
  assert.equal(mapped.headers.get("Location"), `${draft}/preview`);

  const preview = await get(`${draft}/preview`);
  assert.match(preview, /<dt>New contacts<\/dt><dd>2<\/dd>/);
  assert.match(preview, /<li>Line 4: the email doesn&#39;t look like an email address\.<\/li>/);
  assert.doesNotMatch(preview, /Importer|the fair/, "no value from the file on the page");
  const applied = await postFields(`${draft}/apply`, formFields(preview, `${draft}/apply`));
  assert.equal(applied.status, 303);
  const done = applied.headers.get("Location") ?? "";
  const changeId = /change=(chg_[a-z0-9]+)/.exec(done)?.[1] ?? "";
  assert.ok(changeId);
  const result = await get(done);
  assert.match(result, new RegExp(`<p class="banner-text">Imported 2 contacts and filled details on 0; added 1 contact field \\(change ${changeId}\\)</p>`));

  const client: Client = await connectHttp(`${server.url}/mcp`);
  try {
    const found = (await ok(client, "search_contacts", { query: "Importer" })).data as { contacts: { name: string; notes?: string | null }[] };
    assert.deepEqual(found.contacts.map((c) => c.name).sort(), ["Ava Importer", "Ben Importer"]);
    const again = await postFields(`${draft}/apply`, formFields(preview, `${draft}/apply`));
    assert.equal(again.headers.get("Location"), done, "a second apply shows the first result");

    const undone = await postFields(`/changes/${changeId}/undo`, new URLSearchParams({ csrf: token, return_to: draft, confirm: "yes" }));
    assert.equal(undone.status, 303);
    assert.match(await get(draft), /This import was undone\./);
    const gone = (await ok(client, "search_contacts", { query: "Importer" })).data as { contacts: unknown[] };
    assert.deepEqual(gone.contacts, []);
    const fieldsLeft = (await ok(client, "list_fields")).data as { fields: { key: string }[] };
    assert.ok(!fieldsLeft.fields.some((f) => f.key === "budget"), "the new field went with the undo");
  } finally {
    await client.close();
  }
});
