import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/sqlite-d1.ts";
import { labelsFrom, statusLabels } from "./status-labels.ts";

test("labels come from the tables, so a rename shows everywhere; Qualified stays fixed", async () => {
  const db = await createTestDb();
  db.exec("UPDATE person_substatuses SET label = 'Reached' WHERE id = 'lead.contacted'");
  db.exec("UPDATE person_statuses SET label = 'Friend' WHERE key = 'partner'");
  const labels = await statusLabels(db);
  assert.equal(labels.lead("contacted"), "Reached");
  assert.equal(labels.lead("new"), "New");
  assert.equal(labels.lead("qualified"), "Qualified");
  assert.equal(labels.status("partner"), "Friend");
  assert.equal(labels.sub("contact", "client"), "Client");
  assert.equal(labels.sub("contact", null), null);
  assert.equal(labels.both("contact", "client"), "Contact (Client)");
  assert.equal(labels.both("partner", null), "Friend");
});

test("a key with no row falls back to the fixed label, then to the key", () => {
  const labels = labelsFrom([]);
  assert.equal(labels.lead("not_a_fit"), "Not a fit");
  assert.equal(labels.status("lead"), "Lead");
  assert.equal(labels.status("supplier"), "supplier");
  assert.equal(labels.sub("lead", "bad"), "Bad lead");
  assert.equal(labels.sub("supplier", "wholesale"), "wholesale");
});
