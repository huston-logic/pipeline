import assert from "node:assert/strict";
import { test } from "node:test";
import { timeDb } from "../../tests/helpers/time-seed.ts";
import type { ClientRateRow, Db, WorkTypeRow } from "../db/db.ts";
import type { Ctx } from "./change.ts";
import { addTimeEntry } from "./time-entries.ts";
import { undoChange } from "./undo.ts";
import { addWorkType, listWorkTypes, setClientRate, updateWorkType } from "./work-types.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const ctxFor = (db: Db, tool = "add_work_type"): Ctx => ({ db, now: NOW, actor: "ai", tool });
const workType = (db: Db, id: string) => db.prepare("SELECT * FROM work_types WHERE id = ?").bind(id).first<WorkTypeRow>();
const rates = async (db: Db) => (await db.prepare("SELECT * FROM client_rates ORDER BY rowid").all<ClientRateRow>()).results;

test("work type names are unique among live ones, ignoring case", async () => {
  const db = await timeDb(NOW);
  const added = await addWorkType(ctxFor(db), { name: "Copywriting", hourlyRate: 80 });
  assert.match(added.workTypeId, /^wt_[a-z2-7]{12}$/);
  assert.match(added.summary, /^Added work type Copywriting at \$80\.00\/h, billable by default \(change chg_[a-z0-9]{12}\)$/);
  const row = await workType(db, added.workTypeId);
  assert.deepEqual([row?.name, row?.hourly_rate, row?.billable_default, row?.position, row?.archived], ["Copywriting", 80, 1, 3, 0]);

  await assert.rejects(addWorkType(ctxFor(db), { name: "design" }), /^UserError: There's already a work type called Design\. Use another name, or update_work_type to change it\.$/);
  await assert.rejects(updateWorkType(ctxFor(db, "update_work_type"), "Copywriting", { name: "ADMIN" }), /already a work type called Admin/);
  await assert.rejects(addWorkType(ctxFor(db), { name: "  " }), /^UserError: A work type name must be one line of plain text, 1 to 60 characters\.$/);
  await assert.rejects(addWorkType(ctxFor(db), { name: "x".repeat(61) }), /1 to 60 characters/);
  await assert.rejects(addWorkType(ctxFor(db), { name: "Two\nlines" }), /one line of plain text/);
  await assert.rejects(addWorkType(ctxFor(db), { name: "Audit", hourlyRate: -1 }), /^UserError: An hourly rate must be a number from 0 to 100,000, or null for none\.$/);

  const plain = await addWorkType(ctxFor(db), { name: "Travel", hourlyRate: null, billableDefault: false });
  assert.match(plain.summary, /^Added work type Travel, no rate, not billable by default \(change /);
  assert.deepEqual(
    (await listWorkTypes(db)).map((w) => [w.name, w.hourlyRate, w.billableDefault, w.position]),
    [
      ["Design", 95, true, 1],
      ["Admin", null, false, 2],
      ["Copywriting", 80, true, 3],
      ["Travel", null, false, 4],
    ],
  );
});

test("work types archive and restore", async () => {
  const db = await timeDb(NOW);
  const update = (ref: string, patch: Parameters<typeof updateWorkType>[2]) => updateWorkType(ctxFor(db, "update_work_type"), ref, patch);
  const renamed = await update("wt_design", { name: "Web design", hourlyRate: 110, billableDefault: false });
  assert.match(renamed.summary, /^Updated work type Web design: renamed from Design, hourly rate \$95\.00\/h -> \$110\.00\/h and not billable by default \(change /);
  await assert.rejects(update("Web design", { hourlyRate: 110 }), /^UserError: Nothing to change on work type Web design: every value you gave is already set\.$/);

  const archived = await update("Web design", { archived: true });
  assert.match(archived.summary, /^Archived work type Web design \(change /);
  assert.deepEqual((await listWorkTypes(db)).map((w) => w.name), ["Admin"], "an archived one isn't offered");
  await assert.rejects(
    addTimeEntry({ ...ctxFor(db, "add_time_entry"), actor: "owner" }, { startedAt: "2026-11-19T08:00", minutes: 30, workType: "Web design" }),
    /There's no work type "Web design"/,
  );

  // Its name is free again; bringing it back while another live one has the name is refused.
  await addWorkType(ctxFor(db), { name: "web design" });
  await assert.rejects(update("wt_design", { archived: false }), /^UserError: There's already a work type called web design\. /);
  const other = await db.prepare("SELECT id FROM work_types WHERE name = 'web design'").first<string>("id");
  await update(other ?? "", { archived: true });
  const restored = await update("wt_design", { archived: false });
  assert.match(restored.summary, /^Restored work type Web design \(change /);
  assert.equal((await workType(db, "wt_design"))?.archived, 0);
  assert.equal((await listWorkTypes(db)).length, 2);
});

test("client rate set and cleared", async () => {
  const db = await timeDb(NOW);
  const set = (hourlyRate: number | null, contact = "ct_seed01") => setClientRate(ctxFor(db, "set_client_rate"), { workType: "Design", contact, hourlyRate });
  const first = await set(120);
  assert.match(first.summary, /^Set Pat Example's Design rate to \$120\.00\/h \(the default is \$95\.00\/h\) \(change /);
  const changed = await set(130);
  assert.match(changed.summary, /^Changed Pat Example's Design rate from \$120\.00\/h to \$130\.00\/h \(change /);
  await assert.rejects(set(130), /^UserError: Pat Example's Design rate is already \$130\.00\/h\. Nothing to change\.$/);
  assert.deepEqual((await rates(db)).map((r) => [r.work_type_id, r.contact_id, r.hourly_rate, r.archived]), [["wt_design", "ct_seed01", 130, 0]]);
  assert.deepEqual((await listWorkTypes(db))[0]?.clientRates, [{ contactId: "ct_seed01", contact: "Pat Example", hourlyRate: 130 }]);

  const cleared = await set(null);
  assert.match(cleared.summary, /^Cleared Pat Example's Design rate \(back to \$95\.00\/h\) \(change /);
  assert.deepEqual((await rates(db)).map((r) => r.archived), [1]);
  await assert.rejects(set(null), /^UserError: Pat Example has no Design rate of their own to clear\.$/);
  // Set again after clearing: a new row beside the archived one.
  await set(125);
  assert.deepEqual((await rates(db)).map((r) => [r.hourly_rate, r.archived]), [[130, 1], [125, 0]]);

  // An outside name is shown by id.
  const robin = await set(90, "ct_seed02");
  assert.match(robin.summary, /^Set contact ct_seed02's Design rate to \$90\.00\/h/);
  await assert.rejects(setClientRate(ctxFor(db, "set_client_rate"), { workType: "Coding", contact: "ct_seed01", hourlyRate: 1 }), /There's no work type "Coding"/);
  // A long name is cut where it is echoed.
  await assert.rejects(
    setClientRate(ctxFor(db, "set_client_rate"), { workType: "x".repeat(60), contact: "ct_seed01", hourlyRate: 1 }),
    /^UserError: There's no work type "x{39}…"\. Work types: /,
  );
});

test("undo of a work type in use is refused; undo of a client rate is not", async () => {
  const db = await timeDb(NOW);
  const added = await addWorkType(ctxFor(db), { name: "Copywriting", hourlyRate: 80 });
  const rate = await setClientRate(ctxFor(db, "set_client_rate"), { workType: "Copywriting", contact: "ct_seed01", hourlyRate: 90 });
  await addTimeEntry({ ...ctxFor(db, "add_time_entry"), actor: "owner" }, { startedAt: "2026-11-19T08:00", minutes: 30, workType: "Copywriting" });
  await assert.rejects(undoChange(ctxFor(db, "undo_change"), added.changeId), /other records now depend on it \(1 time entry and 1 client rate\)/);
  await undoChange(ctxFor(db, "undo_change"), rate.changeId);
  assert.deepEqual(await rates(db), []);
});

test("work types refuse while time tracking is off", async () => {
  const db = await timeDb(NOW, { on: false });
  const off = /^UserError: Time tracking is off\. The owner can turn it on \(update_settings timeTracking true\)\.$/;
  await assert.rejects(addWorkType(ctxFor(db), { name: "Copywriting" }), off);
  await assert.rejects(updateWorkType(ctxFor(db), "Design", { hourlyRate: 1 }), off);
  await assert.rejects(setClientRate(ctxFor(db), { workType: "Design", contact: "ct_seed01", hourlyRate: 1 }), off);
  await assert.rejects(listWorkTypes(db), off);
});
