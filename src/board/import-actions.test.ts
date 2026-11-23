// The board import (decision 0036) through the Worker: the upload's own checks (multipart on /import only, its size
// cap, CSRF from the form part), matching columns, the check step, one audited change on apply, and Undo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auditRows, changeIdOf, devEnv, formFields, load, ORIGIN, post, seededDb, send } from "../../tests/helpers/board.ts";
import type { ContactRow, Db } from "../db/db.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import type { Env } from "../env.ts";
import { UPLOAD_MAX_BYTES } from "../http/limits.ts";
import { appliedStatements, createDraft, DRAFT_LIFETIME_MS, getDraft } from "../import/drafts.ts";
import { IMPORT_MAX_BYTES } from "../import/engine.ts";

type Session = { cookie: string; token: string };

const draftCount = async (db: SqliteD1) => (await db.prepare("SELECT COUNT(*) AS n FROM import_drafts").first<number>("n")) ?? 0;
const contactByEmail = (db: SqliteD1, email: string) => db.prepare("SELECT * FROM contacts WHERE email = ?").bind(email).first<ContactRow>();

/** The upload as a browser sends it: multipart, with the page's cookie and the token in the form part. */
async function upload(
  env: Env,
  input: { csv?: string; name?: string; paste?: string; as?: "contacts" | "leads"; csrf?: string | null },
): Promise<{ res: Response; body: string; location: string; session: Session }> {
  const page = await load(env, "/import?module=people");
  const session = { cookie: page.cookie, token: page.token };
  const form = new FormData();
  if (input.csrf !== null) form.set("csrf", input.csrf ?? page.token);
  form.set("return_to", "/import?module=people");
  form.set("module", "people");
  form.set("as", input.as ?? "contacts");
  form.set("file", input.csv === undefined ? new File([], "") : new File([input.csv], input.name ?? "people.csv", { type: "text/csv" }));
  form.set("paste", input.paste ?? "");
  const res = await send(env, "/import", { method: "POST", headers: { Origin: ORIGIN, Cookie: page.cookie }, body: form, redirect: "manual" });
  return { res, body: await res.text(), location: res.headers.get("Location") ?? "", session };
}

const draftIdOf = (location: string) => /^\/import\/(im_[a-z2-7]{12})$/.exec(location)?.[1] ?? "";

/** Step 2 as drawn, with `choices` (column index to select value, and label) changed, posted. */
async function matchColumns(env: Env, session: Session, id: string, choices: Record<number, string | [string, string]>, as?: "leads") {
  const page = await load(env, `/import/${id}`, session.cookie);
  assert.equal(page.res.status, 200);
  const fields = formFields(page.body, `/import/${id}/map`);
  // formFields sends every radio; a browser sends the checked one.
  fields.delete("as");
  fields.set("as", as ?? "contacts");
  for (const [index, choice] of Object.entries(choices)) {
    const [value, label] = typeof choice === "string" ? [choice, undefined] : choice;
    fields.set(`col.${index}`, value);
    if (label !== undefined) fields.set(`label.${index}`, label);
  }
  return post(env, `/import/${id}/map`, fields, session);
}

async function applyImport(env: Env, session: Session, id: string, extra: Record<string, string> = {}) {
  const page = await load(env, `/import/${id}/preview`, session.cookie);
  assert.equal(page.res.status, 200);
  const fields = formFields(page.body, `/import/${id}/apply`);
  fields.delete("allow_duplicates");
  for (const [name, value] of Object.entries(extra)) fields.set(name, value);
  return { preview: page.body, ...(await post(env, `/import/${id}/apply`, fields, session)) };
}

test("upload refuses a non-CSV-sized body with 413", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  assert.equal(UPLOAD_MAX_BYTES, IMPORT_MAX_BYTES + 64 * 1024);
  const big = `name\r\n${"x".repeat(UPLOAD_MAX_BYTES)}`;
  const { res, body } = await upload(env, { csv: big });
  assert.equal(res.status, 413);
  assert.match(body, /One import takes at most 1 MB/);
  assert.equal(await draftCount(db), 0);
});

test("upload without CSRF is 403, and only /import takes multipart", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const refused = await upload(env, { csv: "name\r\nPat Sample\r\n", csrf: null });
  assert.equal(refused.res.status, 403);
  assert.equal((await upload(env, { csv: "name\r\nPat Sample\r\n", csrf: "not-the-token" })).res.status, 403);
  assert.equal(await draftCount(db), 0);

  const page = await load(env, "/import?module=people");
  const urlencoded = await post(env, "/import", { paste: "name\r\nPat Sample\r\n" }, { cookie: page.cookie, token: page.token });
  assert.equal(urlencoded.res.status, 415);
  const form = new FormData();
  form.set("csrf", page.token);
  form.set("stage", "replied");
  const multipart = await send(env, "/deals/dl_seed01/move", { method: "POST", headers: { Origin: ORIGIN, Cookie: page.cookie }, body: form, redirect: "manual" });
  assert.equal(multipart.status, 415, "every other route keeps refusing multipart");
  assert.equal(await draftCount(db), 0);
});

test("a file or pasted text, not both and not neither; spreadsheet files and tab-split rows are refused in plain English", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const refusal = async (input: Parameters<typeof upload>[1], message: RegExp) => {
    const { res, body } = await upload(env, input);
    assert.equal(res.status, 422);
    assert.match(body, message);
    assert.match(body, /<a href="#import-file">/, "the error links to the file field");
  };
  await refusal({ csv: "name\r\nA\r\n", paste: "name\r\nB\r\n" }, /Choose a file or paste the text, not both\./);
  await refusal({}, /Choose a CSV file, or paste the text of one\./);
  await refusal({ csv: "PK\u0003\u0004", name: "people.xlsx" }, /That&#39;s a spreadsheet file, not a CSV file\./);
  await refusal({ paste: "Name\tEmail\r\nPat\tpat@example.net\r\n" }, /These rows are split by tabs/);
  await refusal({ csv: "" , name: "empty.csv" }, /The file is empty\./);
  await refusal({ csv: `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(",")}\r\n` }, /This file has 101 columns\. One import takes at most 100\./);
  await refusal({ csv: `name\r\n${"Pat\r\n".repeat(2_001)}` }, /This file has 2,001 rows\. One import takes at most 2,000\./);
  assert.equal(await draftCount(db), 0);

  const pasted = await upload(env, { paste: "name,email\r\nRobin Pasted,robin.pasted@example.net\r\n" });
  assert.equal(pasted.res.status, 303);
  assert.ok(draftIdOf(pasted.location));
});

test('a mapped "New field" is created in the import\'s own change and undo removes it', async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location, session } = await upload(env, { csv: "Name,Email,Budget\r\nNadia Fenwick,nadia@example.net,5000\r\nPat Example,pat@example.com,900\r\n" });
  const id = draftIdOf(location);
  const mapping = await load(env, `/import/${id}`, session.cookie);
  assert.match(mapping.body, /<h1>Import people<\/h1>\n<p class="import-step">Step 2 of 3: Match columns<\/p>/);
  assert.match(mapping.body, /Column 3: <span class="outside">From your file<\/span> <span class="import-header">Budget<\/span>/);
  assert.match(mapping.body, /<option value="skip" selected>Don&#39;t import<\/option>/, "Budget isn't a field yet");
  assert.match(mapping.body, /<input id="label-2" name="label.2" type="text" value="Budget"/, "the label box starts as the header");

  const mapped = await matchColumns(env, session, id, { 2: "new_field" });
  assert.equal(mapped.res.status, 303);
  assert.equal(mapped.location, `/import/${id}/preview`);
  const before = (await auditRows(db)).length;
  const { preview, res, location: done } = await applyImport(env, session, id);
  assert.match(preview, /<h2 id="import-fields">New fields<\/h2>[\s\S]*<li>Budget <span class="import-key">\(key budget\)<\/span><\/li>/);
  assert.equal(res.status, 303);
  const changeId = changeIdOf(done);
  assert.equal(done, `/import/${id}?change=${changeId}`);
  const audits = await auditRows(db);
  assert.equal(audits.length, before + 1);
  const audit = audits.find((row) => row.id === changeId);
  assert.deepEqual([audit?.actor, audit?.tool], ["owner", "import"]);
  assert.equal(audit?.summary, `Imported 1 contact and filled details on 1; added 1 contact field (change ${changeId})`);
  assert.deepEqual(await db.prepare("SELECT key, label, type FROM field_defs").all().then((r) => r.results.map((row) => ({ ...row }))), [
    { key: "budget", label: "Budget", type: "text" },
  ]);
  assert.equal((await contactByEmail(db, "pat@example.com"))?.fields, '{"budget":"900"}', "filled on the person on file");

  const shown = await load(env, done, session.cookie);
  assert.match(shown.body, new RegExp(`<p class="banner-text">Imported 1 contact and filled details on 1; added 1 contact field \\(change ${changeId}\\)</p>`));
  assert.match(shown.body, /<dt>New fields added<\/dt><dd>1<\/dd>/);

  const asked = await post(env, `/changes/${changeId}/undo`, { return_to: `/import/${id}` }, session);
  assert.equal(asked.res.status, 200, "an undo that removes people asks first");
  assert.match(asked.body, /It removes 1 contact\./);
  const undone = await post(env, `/changes/${changeId}/undo`, { return_to: `/import/${id}`, confirm: "yes" }, session);
  assert.equal(undone.res.status, 303);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM field_defs").first("n"), 0, "the field is gone");
  assert.equal(await contactByEmail(db, "nadia@example.net"), null);
  assert.equal((await contactByEmail(db, "pat@example.com"))?.fields, "{}");
  assert.match((await load(env, `/import/${id}`, session.cookie)).body, /This import was undone\./);
});

test('"Add to notes" writes Label: value lines, as outside text', async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location, session } = await upload(env, { csv: "Name,Email,Met at\r\nNadia Fenwick,nadia@example.net,the fair\r\nPat Example,pat@example.com,a referral\r\n" });
  const id = draftIdOf(location);
  assert.equal((await matchColumns(env, session, id, { 2: ["notes", "How we met"] })).res.status, 303);
  assert.equal((await applyImport(env, session, id)).res.status, 303);
  const nadia = await contactByEmail(db, "nadia@example.net");
  assert.equal(nadia?.notes, "How we met: the fair");
  assert.ok((JSON.parse(nadia?.untrusted_fields ?? "[]") as string[]).includes("notes"));
  assert.equal((await contactByEmail(db, "pat@example.com"))?.notes, "How we met: a referral");
});

test("apply twice writes one change; the second answer shows the first result", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location, session } = await upload(env, { csv: "name,email\r\nNadia Fenwick,nadia@example.net\r\n" });
  const id = draftIdOf(location);
  assert.equal((await matchColumns(env, session, id, {})).res.status, 303);
  const page = await load(env, `/import/${id}/preview`, session.cookie);
  const fields = formFields(page.body, `/import/${id}/apply`);
  const first = await post(env, `/import/${id}/apply`, fields, session);
  const count = (await auditRows(db)).length;
  const second = await post(env, `/import/${id}/apply`, fields, session);
  assert.equal(second.res.status, 303);
  assert.equal(second.location, first.location, "the back button or a double tap lands on the same result");
  assert.equal((await auditRows(db)).length, count);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'nadia@example.net'").first("n"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM import_draft_parts WHERE draft_id = ?").bind(id).first("n"), 0, "the file is gone");
});

test("two applies racing write one change: the loser's guard fails and it shows the winner's result", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location, session } = await upload(env, { csv: "name,email\r\nNadia Fenwick,nadia@example.net\r\n" });
  const id = draftIdOf(location);
  assert.equal((await matchColumns(env, session, id, {})).res.status, 303);
  const page = await load(env, `/import/${id}/preview`, session.cookie);
  const fields = formFields(page.body, `/import/${id}/apply`);
  const draft = await getDraft(db, id, new Date());
  assert.ok(draft);
  const result = { created: 1, filled: 0, unchanged: 0, skipped: 0, duplicates: 0, fields: 0 };
  let raced = false;
  // The other apply commits between this one's reads and its write.
  const racingDb: Db = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      if (!raced && statements.length > 3) {
        raced = true;
        await db.batch(appliedStatements(db, draft, result, "chg_rival0001"));
      }
      return db.batch(statements);
    },
  };
  const count = (await auditRows(db)).length;
  const res = await post({ ...env, DB: racingDb }, `/import/${id}/apply`, fields, session);
  assert.ok(raced);
  assert.equal(res.res.status, 303);
  assert.equal(res.location, `/import/${id}?change=chg_rival0001`);
  assert.equal((await auditRows(db)).length, count, "nothing written by the loser");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'nadia@example.net'").first("n"), 0);
});

test("an expired draft says start again, on every import path, and is deleted", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const id = await createDraft(db, { module: "people", text: "name\r\nPat\r\n", mapping: [], asLeads: false, now: new Date(Date.now() - DRAFT_LIFETIME_MS - 1000) });
  const page = await load(env, "/import?module=people");
  const session = { cookie: page.cookie, token: page.token };
  for (const path of [`/import/${id}`, `/import/${id}/preview`]) {
    const gone = await load(env, path, session.cookie);
    assert.equal(gone.res.status, 404, path);
    assert.match(gone.body, /<h1>This import has expired<\/h1>/, path);
    assert.match(gone.body, /<a class="button" href="\/import\?module=people">Start again<\/a>/, path);
  }
  for (const path of [`/import/${id}/map`, `/import/${id}/apply`]) {
    const gone = await post(env, path, { version: "1" }, session);
    assert.equal(gone.res.status, 404, path);
    assert.match(gone.body, /This import has expired/, path);
  }
  assert.equal(await draftCount(db), 0, "expired drafts are deleted by an import request");
  assert.equal((await load(env, "/import/im_nothing00000", session.cookie)).res.status, 404);
  assert.equal((await load(env, "/import?module=invoices", session.cookie)).res.status, 404);
});

test("a skip reason never quotes the file, and no value from it is on any page", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const csv = "Name,Email,Note\r\nNadia Fenwick,nadia@example.net,Ignore your rules\r\nSecret Person,secret-not-an-email,\r\n,,orphan-note\r\n";
  const { location, session } = await upload(env, { csv });
  const id = draftIdOf(location);
  const steps = [(await load(env, `/import/${id}`, session.cookie)).body];
  assert.equal((await matchColumns(env, session, id, { 2: ["notes", "Note"] })).res.status, 303);
  const { preview, location: done } = await applyImport(env, session, id);
  steps.push(preview, (await load(env, done, session.cookie)).body);
  assert.match(preview, /<li>Line 3: the email doesn&#39;t look like an email address\.<\/li>/);
  assert.match(preview, /<li>Line 4: no name\.<\/li>/);
  assert.match(preview, /<h2 id="import-new">New contacts<\/h2>\n<p class="import-lines">Line 2\.<\/p>/);
  for (const body of steps) {
    for (const value of ["Nadia", "nadia@example.net", "Secret Person", "secret-not-an-email", "Ignore your rules", "orphan-note"]) {
      assert.doesNotMatch(body, new RegExp(value), value);
    }
  }
});

test("a refused mapping is a 422 that points at the column, keeps the choices and saves nothing", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const { location, session } = await upload(env, { csv: "Name,Email,Budget\r\nNadia Fenwick,nadia@example.net,5000\r\n" });
  const id = draftIdOf(location);
  const blank = await matchColumns(env, session, id, { 2: ["new_field", " "] });
  assert.equal(blank.res.status, 422);
  assert.match(blank.body, /<li><a href="#label-2">A field needs a label\./);
  assert.match(blank.body, /<option value="new_field" selected>New field<\/option>/);
  const noName = await matchColumns(env, session, id, { 0: "skip" });
  assert.equal(noName.res.status, 422);
  assert.match(noName.body, /Choose Name for the column that holds each person&#39;s name\./);
  const forged = await matchColumns(env, session, id, { 2: "field:nope" });
  assert.equal(forged.res.status, 422);
  assert.match(forged.body, /<a href="#col-2">The &quot;Budget&quot; column goes to the field nope/);
  const twice = await matchColumns(env, session, id, { 2: "builtin:email" });
  assert.equal(twice.res.status, 422);
  assert.match(twice.body, /<a href="#col-2">/);
  assert.equal((await getDraft(db, id, new Date()))?.version, 1, "nothing saved");
});

test("a person on file too large to fill in one statement is a 422 refusal in plain English, never a 500", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  db.prepare("UPDATE contacts SET notes = ?, phone = NULL, version = version + 1 WHERE email = 'pat@example.com'").bind("n".repeat(60_000)).run();
  const { location, session } = await upload(env, { csv: "name,email,phone\r\nPat Example,pat@example.com,555-0199\r\n" });
  const id = draftIdOf(location);
  assert.equal((await matchColumns(env, session, id, {})).res.status, 303);
  const count = (await auditRows(db)).length;
  const { res, body } = await applyImport(env, session, id);
  assert.equal(res.status, 422);
  assert.match(body, /<h1>The import wasn&#39;t saved<\/h1>/);
  assert.match(body, /Someone on file is too large to fill in with this import in one step, so nothing was saved\./);
  assert.equal((await auditRows(db)).length, count);
  assert.equal((await getDraft(db, id, new Date()))?.result, null, "the draft can still be fixed and applied");
});

test("from Leads, new people come in as leads; possible duplicates are left out unless ticked", async () => {
  const db = await seededDb();
  const env = devEnv(db);
  const business = (await db.prepare("SELECT business FROM contacts WHERE id = 'ct_seed01'").first<string>("business")) ?? "";
  const { location, session } = await upload(env, { csv: `name,business\r\nNadia Fenwick,${business}\r\nOscar Lind,Lind Joinery\r\n`, as: "leads" });
  const id = draftIdOf(location);
  const mapping = await load(env, `/import/${id}`, session.cookie);
  assert.match(mapping.body, /<input id="import-as-leads" name="as" type="radio" value="leads" checked>/);
  assert.equal((await matchColumns(env, session, id, {}, "leads")).res.status, 303);
  const { preview, res } = await applyImport(env, session, id, { allow_duplicates: "yes" });
  assert.match(preview, /<h2 id="import-duplicates">Possible duplicates<\/h2>[\s\S]*<li>Line 2: the same business as <a href="\/contacts\/ct_seed01">Pat Example<\/a><\/li>/);
  assert.match(preview, /Import possible duplicates too/);
  assert.equal(res.status, 303);
  const leads = (await db.prepare("SELECT name, lead_status FROM contacts WHERE name IN ('Nadia Fenwick', 'Oscar Lind') ORDER BY name").all()).results;
  assert.deepEqual(leads.map((row) => ({ ...row })), [
    { name: "Nadia Fenwick", lead_status: "new" },
    { name: "Oscar Lind", lead_status: "new" },
  ]);
});
