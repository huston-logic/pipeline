// "This is my own list" (decision 0038): with the box ticked, a People or Deals import stores short, single-line
// identity values as the owner's; notes, titles, next steps, custom fields, "Add to notes" lines and long values stay
// outside text. Without it, nothing changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContactRow, DealRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { createTestDb, type SqliteD1 } from "../db/sqlite-d1.ts";
import { commitChange } from "../services/change.ts";
import { IMPORT_ACTOR } from "./change.ts";
import { fileChange, mapFile, planRows, type Target } from "./engine.ts";
import { contactsOnFile, dealsOnFile } from "./load.ts";
import { dealsModule } from "./modules/deals.ts";
import { peopleModule } from "./modules/people.ts";
import { isOwnListValue, OWN_LIST_MAX } from "./own-list.ts";

const NOW = new Date("2026-11-23T18:00:00.000Z");

async function withPat(): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(`INSERT INTO contacts (id, name, email, phone, business, source, notes, untrusted_fields, created_at, updated_at) VALUES
    ('ct_pat', 'Pat Example', 'pat@example.com', NULL, NULL, NULL, 'Met in May', '["source"]', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type) VALUES
    ('fd_size', 'contact', 'size', 'Size', 'text'), ('fd_budget', 'deal', 'budget', 'Budget', 'text')`);
  return db;
}

async function importPeople(db: SqliteD1, csv: string, ownList: boolean, targets?: Target[]) {
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const header = csv.split("\r\n")[0]?.split(",") ?? [];
  const mapping = targets ?? header.map((cell): Target => (cell === "size" ? { kind: "field", key: "size" } : { kind: "builtin", key: cell }));
  const mapped = mapFile(peopleModule, csv, mapping, fieldDefs, NOW);
  const ctx = await contactsOnFile(db);
  const plan = planRows(peopleModule, mapped.rows, ctx, { asLeads: false, allowDuplicates: false, ownList, fieldDefs: mapped.fieldDefs });
  const input = fileChange(peopleModule, plan, ctx, NOW, mapped.newFields);
  assert.ok(input);
  return { plan, result: await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input) };
}

const byEmail = (db: SqliteD1, email: string) => db.prepare("SELECT * FROM contacts WHERE email = ?").bind(email).first<ContactRow>();
const outside = (row: { untrusted_fields: string } | null) => (JSON.parse(row?.untrusted_fields ?? "null") as string[]).sort();

test("own list: short identity values are trusted, notes stay outside", async () => {
  const db = await withPat();
  const csv = [
    "name,email,phone,business,source,notes,size,met",
    "Nadia Fenwick,nadia@example.net,555 0100,Fenwick Joinery,the fair,Wants a quote,large,at the fair",
    "Someone Else,pat@example.com,555 0101,Example Plumbing,referral,Call back,small,a referral",
  ].join("\r\n");
  const targets: Target[] = [
    ...["name", "email", "phone", "business", "source", "notes"].map((key): Target => ({ kind: "builtin", key })),
    { kind: "field", key: "size" },
    { kind: "notes", label: "Met" },
  ];
  const { result } = await importPeople(db, csv, true, targets);
  assert.equal(result.summary, `Imported 1 contact and filled details on 1 (change ${result.changeId})`, "counts only");

  const nadia = await byEmail(db, "nadia@example.net");
  assert.deepEqual(
    [nadia?.name, nadia?.business, nadia?.phone, nadia?.source, nadia?.notes],
    ["Nadia Fenwick", "Fenwick Joinery", "555 0100", "the fair", "Wants a quote\nMet: at the fair"],
  );
  assert.deepEqual(outside(nadia), ["notes", "size"], "only the notes and the custom field stay outside text");

  // A merge: the filled identity values are the owner's and the filled notes stay outside; the mark on file (source)
  // stays as it is, and the name and email on file are never touched.
  const pat = await db.prepare("SELECT * FROM contacts WHERE id = 'ct_pat'").first<ContactRow>();
  assert.deepEqual([pat?.name, pat?.phone, pat?.business, pat?.source], ["Pat Example", "555 0101", "Example Plumbing", "referral"]);
  assert.equal(pat?.notes, "Met in May\nMet: a referral");
  assert.deepEqual(outside(pat), ["notes", "size", "source"]);

  // Unticked, the same file is outside text throughout.
  const plain = await withPat();
  await importPeople(plain, csv, false, targets);
  assert.deepEqual(outside(await byEmail(plain, "nadia@example.net")), ["business", "email", "name", "notes", "phone", "size", "source"]);
  assert.deepEqual(outside(await plain.prepare("SELECT * FROM contacts WHERE id = 'ct_pat'").first<ContactRow>()), [
    "business",
    "notes",
    "phone",
    "size",
    "source",
  ]);
});

test("own list: a deals import confirms the people it adds; the deal's own values stay outside", async () => {
  const db = await withPat();
  const csv = ["title,name,email,business,next_step,budget", "Shop sign,Nadia Fenwick,nadia@example.net,Fenwick Joinery,Send the quote,900"].join("\r\n");
  const fieldDefs = await listFieldDefs(db, { includeArchived: true });
  const mapping: Target[] = [
    ...["title", "name", "email", "business", "next_step"].map((key): Target => ({ kind: "builtin", key })),
    { kind: "field", key: "budget" },
  ];
  const mapped = mapFile(dealsModule, csv, mapping, fieldDefs, NOW);
  const ctx = await dealsOnFile(db, mapped.rows);
  const plan = planRows(dealsModule, mapped.rows, ctx, { closedAsHistory: false, ownList: true, fieldDefs: mapped.fieldDefs });
  const input = fileChange(dealsModule, plan, ctx, NOW, []);
  assert.ok(input);
  await commitChange({ db, now: NOW, ...IMPORT_ACTOR }, input);
  const nadia = await byEmail(db, "nadia@example.net");
  assert.deepEqual(outside(nadia), [], "the person's name, email and business are the owner's");
  const deal = await db.prepare("SELECT * FROM deals WHERE contact_id = ?").bind(nadia?.id ?? "").first<DealRow>();
  assert.deepEqual(outside(deal), ["budget", "next_step", "title"]);
});

test("own list: a 201-character name stays outside", async () => {
  assert.equal(OWN_LIST_MAX, 200);
  const db = await withPat();
  const long = "N".repeat(201);
  const edge = "E".repeat(200);
  const csv = [
    "name,email,business",
    `${long},long@example.net,Short Shop`,
    `${edge},edge@example.net,Edge Shop`,
    // A bidi override and a zero-width space are not plain text: that value stays outside.
    "Riley ‮niaga,riley@example.net,Shop​ Two",
  ].join("\r\n");
  await importPeople(db, csv, true);
  assert.deepEqual(outside(await byEmail(db, "long@example.net")), ["name"], "only the long value stays outside");
  assert.deepEqual(outside(await byEmail(db, "edge@example.net")), [], "200 characters is the most the box confirms");
  assert.deepEqual(outside(await byEmail(db, "riley@example.net")), ["business", "name"]);

  assert.equal(isOwnListValue("Pat Example"), true);
  for (const text of [null, "", "   ", "x".repeat(201), "two\nlines", "a\ttab", "line separator", "⁦isolate⁩", "\uD800"]) {
    assert.equal(isOwnListValue(text), false, JSON.stringify(text));
  }
});

test("own list: a custom field with an identity column's key keeps that key marked, on a new person and a merge", async () => {
  const db = await withPat();
  db.exec(`INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_phone', 'contact', 'phone', 'Phone', 'text')`);
  const csv = ["name,email,phone,mobile", "Nadia Fenwick,nadia@example.net,555 0100,555 0199", "Pat,pat@example.com,555 0101,555 0198"].join("\r\n");
  const targets: Target[] = [
    { kind: "builtin", key: "name" },
    { kind: "builtin", key: "email" },
    { kind: "builtin", key: "phone" },
    { kind: "field", key: "phone" },
  ];
  await importPeople(db, csv, true, targets);
  assert.deepEqual(outside(await byEmail(db, "nadia@example.net")), ["phone"], "outside wins");
  assert.deepEqual(outside(await byEmail(db, "pat@example.com")), ["phone", "source"]);
});

test("own list: invisible and stacked characters keep a value outside (fix round 1)", () => {
  const hidden = [
    // Variation selectors carrying a hidden payload after a short name.
    ["variation selectors", `Pat Lee${"️︎︁".repeat(5)}`],
    ["supplementary variation selectors", `Pat Lee\u{E0100}\u{E0101}\u{E01EF}`],
    ["combining grapheme joiner", "Pat͏Lee"],
    ["Hangul fillers only", "ᅟᅠㅤﾠ"],
    ["a Hangul filler in a name", "PatㅤLee"],
    ["braille blank", "Pat⠀Lee"],
    ["tag characters", "Pat Lee\u{E0049}\u{E0067}"],
    ["soft hyphen", "Pat­Lee"],
    ["an unassigned code point", "Pat͸Lee"],
    ["four combining marks in a row", "Paté̂̃̄"],
    ["fewer visible characters than half its length", "a                   b"],
    ["marks outnumbering letters", "Pá̂̃t́̂̃"],
  ] as const;
  for (const [what, text] of hidden) assert.equal(isOwnListValue(text), false, what);

  // Ordinary names, accents (composed or one combining mark), other scripts and an emoji still count.
  for (const text of ["Pat Lee", "J. R. Example", "José Núñez", "José Núñez", "हिन्दी नाम", "李小龙", "O'Brien-Example", "Pat 🙂"]) {
    assert.equal(isOwnListValue(text), true, text);
  }
});

test("own list: a name with a hidden payload is stored as outside text", async () => {
  const db = await withPat();
  const csv = ["name,email,business", `Pat Lee${"️".repeat(40)},hidden@example.net,ㅤㅤ`].join("\r\n");
  await importPeople(db, csv, true);
  const row = await byEmail(db, "hidden@example.net");
  assert.equal(row?.name.startsWith("Pat Lee️"), true, "stored as it came");
  assert.deepEqual(outside(row), ["business", "name"], "only the plain email is confirmed");
});
