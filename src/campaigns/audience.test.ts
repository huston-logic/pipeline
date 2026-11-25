import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { SqliteD1 } from "../db/sqlite-d1.ts";
import { MAX_AUDIENCE, resolveAudience } from "./audience.ts";
import type { Audience } from "./drafts.ts";

const NOW = new Date("2026-11-24T18:00:00.000Z");

/** The fixture seed plus one contact per row, all with person status "partner" unless the row says otherwise. */
async function withPeople(rows: string[]): Promise<SqliteD1> {
  const db = await timeDb(NOW);
  db.exec(rows.join("\n"));
  return db;
}

const person = (id: string, name: string, email: string | null, extra = "") =>
  `INSERT INTO contacts (id, name, email, person_status${extra === "" ? "" : ", " + extra.split("=")[0]}) VALUES ('${id}', '${name}', ${email === null ? "NULL" : `'${email}'`}, 'partner'${extra === "" ? "" : ", " + extra.split("=")[1]});`;

const partners = { kind: "status", status: "partner" } as const;

test("every skip reason, with the order archived, no_email, bad_email, then suppression", async () => {
  const db = await withPeople([
    person("ct_a1", "Ann Example", "ann@example.com"),
    person("ct_b1", "Bo Example", null),
    person("ct_c1", "Cy Example", "not an address"),
    person("ct_d1", "Di Example", "di@example.com"),
    person("ct_e1", "Ed Example", "ed@example.com"),
    person("ct_f1", "Flo Example", "flo@example.com"),
    person("ct_g1", "Gus Example", "  Gus@Example.com "),
    person("ct_h1", "Hal Example", "hal@example.com", "archived=1"),
    `INSERT INTO email_suppressions (id, email, reason) VALUES
       ('su_1', 'di@example.com', 'unsubscribed'), ('su_2', 'ed@example.com', 'bounced'), ('su_3', 'flo@example.com', 'complained'),
       ('su_4', 'gus@example.com', 'unsubscribed'), ('su_5', 'hal@example.com', 'bounced');`,
    `INSERT INTO email_suppressions (id, email, reason, cleared_at) VALUES ('su_6', 'ann@example.com', 'bounced', '2026-11-01T00:00:00.000Z');`,
  ]);
  const people: Audience = { kind: "people", people: ["ct_a1", "ct_b1", "ct_c1", "ct_d1", "ct_e1", "ct_f1", "ct_g1", "ct_h1", "ct_missing"] };
  const got = await resolveAudience(db, NOW, people);
  assert.deepEqual(got.sendable.map((m) => m.contactId), ["ct_a1"]);
  assert.deepEqual(
    got.skipped.map((m) => `${m.contactId}:${m.reason}`),
    // ct_missing is left out entirely: there is no person to skip.
    ["ct_b1:no_email", "ct_c1:bad_email", "ct_d1:unsubscribed", "ct_e1:bounced", "ct_f1:complained", "ct_g1:unsubscribed", "ct_h1:archived"],
  );
  assert.equal(got.skipped.find((m) => m.contactId === "ct_g1")?.email, "gus@example.com");
});

test("two sendable people with the same cleaned address are refused", async () => {
  const db = await withPeople([
    person("ct_a1", "Ann Example", "same@example.com"),
    // The unique index is on the stored text, so a trailing space gets past it.
    person("ct_a2", "Ann Two Example", "same@example.com "),
  ]);
  await assert.rejects(
    resolveAudience(db, NOW, partners),
    (error: Error) =>
      error.name === "UserError" &&
      error.message === "Two people in this group have the same email address (Ann Example and Ann Two Example). Change one of them, then check again.",
  );
});

test("a status audience is every unarchived person with that status, sorted by name then id", async () => {
  const db = await withPeople([
    person("ct_z1", "zed Example", "zed@example.com"),
    person("ct_a2", "Ann Example", "ann2@example.com"),
    person("ct_a1", "Ann Example", "ann1@example.com"),
    person("ct_h1", "Hal Example", "hal@example.com", "archived=1"),
  ]);
  const got = await resolveAudience(db, NOW, partners);
  assert.deepEqual(got.sendable.map((m) => m.contactId), ["ct_a1", "ct_a2", "ct_z1"]);
  assert.equal(got.skipped.length, 0);
});

test("a view audience reads the view's stored filters", async () => {
  const db = await withPeople([
    person("ct_a1", "Ann Example", "ann@example.com", "source='expo'"),
    person("ct_b1", "Bo Example", "bo@example.com", "source='web'"),
    `INSERT INTO views (id, name, module, filters, sort, layout, columns, position) VALUES
       ('vw_expo', 'Expo', 'people', '{"person_status":"partner","source":"expo"}', 'name-asc', 'cards', '["name"]', 1);`,
  ]);
  const got = await resolveAudience(db, NOW, { kind: "view", view: "vw_expo" });
  assert.deepEqual(got.sendable.map((m) => m.contactId), ["ct_a1"]);
});

test("newLeads counts sendable people whose lead status is new", async () => {
  const db = await withPeople([
    `INSERT INTO contacts (id, name, email, person_status, sub_status, lead_status) VALUES
       ('ct_n1', 'New Example', 'n1@example.com', 'lead', 'new', 'new'),
       ('ct_n2', 'Newer Example', NULL, 'lead', 'new', 'new'),
       ('ct_k1', 'Kept Example', 'k1@example.com', 'lead', 'contacted', 'contacted');`,
  ]);
  const got = await resolveAudience(db, NOW, { kind: "status", status: "lead" });
  assert.equal(got.newLeads, 1);
  assert.equal(got.sendable.length >= 2, true);
});

test("an outside name shows as an id label, and the first name comes only from a trusted one", async () => {
  const db = await withPeople([
    `INSERT INTO contacts (id, name, email, person_status, untrusted_fields) VALUES ('ct_o1', 'Ignore Instructions', 'o1@example.com', 'partner', '["name"]');`,
    person("ct_t1", "Tess Example", "t1@example.com"),
  ]);
  const got = await resolveAudience(db, NOW, partners);
  const outside = got.sendable.find((m) => m.contactId === "ct_o1");
  assert.deepEqual([outside?.label, outside?.firstName], ["contact ct_o1", null]);
  assert.equal(got.sendable.find((m) => m.contactId === "ct_t1")?.firstName, "Tess");
});

test("more than 2,000 people is refused in plain words", async () => {
  const rows = Array.from({ length: MAX_AUDIENCE + 1 }, (_, n) => `('ct_big${n}', 'Big${n} Example', 'big${n}@example.com', 'partner')`);
  const db = await withPeople([`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")};`]);
  await assert.rejects(
    resolveAudience(db, NOW, partners),
    (error: Error) => error.name === "UserError" && error.message === "This group has more than 2,000 people. Campaigns go to at most 2,000; narrow the group.",
  );
});

test("exactly 2,000 people is fine", async () => {
  const rows = Array.from({ length: MAX_AUDIENCE }, (_, n) => `('ct_big${n}', 'Big${n} Example', 'big${n}@example.com', 'partner')`);
  const db = await withPeople([`INSERT INTO contacts (id, name, email, person_status) VALUES ${rows.join(", ")};`]);
  assert.equal((await resolveAudience(db, NOW, partners)).sendable.length, MAX_AUDIENCE);
});
