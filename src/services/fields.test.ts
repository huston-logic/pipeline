import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, FieldDefRow } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addField, fieldOverview, updateField, validateFieldValues } from "./fields.ts";
import { addLead, updateContact } from "./leads.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const LATER = new Date("2026-11-19T19:00:00.000Z");
const ctxFor = (db: Db, tool: string, now = NOW): Ctx => ({ db, now, actor: "ai", tool });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof UserError, `expected a UserError, got ${String(error)}`);
  return error.message;
}

const def = (over: Partial<FieldDefRow>): FieldDefRow => ({
  id: "fd_test",
  entity: "deal",
  key: "budget",
  label: "Budget",
  type: "text",
  choices: null,
  archived: 0,
  version: 1,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

test("addField stores a field keyed by the slug of its label, with a fd_ id, in one audited change", async () => {
  const db = await openTestDb();
  const result = await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Budget (USD)", type: "number" });

  assert.equal(result.summary, `Added deal field Budget (USD) (key budget_usd, number) (change ${result.changeId})`);
  assert.match(result.fieldId, /^fd_[a-z2-7]{12}$/);
  const [row] = await listFieldDefs(db);
  assert.equal(row?.id, result.fieldId);
  assert.equal(row?.key, "budget_usd");
  assert.equal(row?.entity, "deal");
  assert.equal(row?.choices, null);
  const audit = await db.prepare("SELECT tool, target_table, target_id FROM audit_log").first<Record<string, string>>();
  assert.deepEqual(audit, { tool: "add_field", target_table: "field_defs", target_id: result.fieldId });
});

test("a choice field needs unique choices; other types refuse them", async () => {
  const db = await openTestDb();
  const added = await addField(ctxFor(db, "add_field"), {
    entity: "contact",
    label: "Temperature",
    type: "choice",
    choices: [" Cold ", "Warm", "Hot"],
  });
  assert.match(added.summary, /^Added contact field Temperature \(key temperature, choice: Cold, Warm, Hot\)/);
  assert.deepEqual(JSON.parse((await listFieldDefs(db))[0]?.choices ?? ""), ["Cold", "Warm", "Hot"]);

  assert.match(await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: "Size", type: "choice" })), /needs choices/);
  assert.match(await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: "Size", type: "choice", choices: [] })), /needs choices/);
  assert.match(
    await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: "Size", type: "choice", choices: ["S", "s"] })),
    /listed twice/,
  );
  assert.match(
    await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: "Size", type: "text", choices: ["S"] })),
    /Only choice fields take choices/,
  );
});

test("keys are unique per entity: the same label on a contact and a deal is fine, a clashing slug gets _2", async () => {
  const db = await openTestDb();
  const a = await addField(ctxFor(db, "add_field"), { entity: "contact", label: "Referrer", type: "text" });
  const b = await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Referrer", type: "text" });
  const c = await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Referrer!", type: "text" });
  const rows = await listFieldDefs(db);
  assert.deepEqual(
    rows.map((r) => [r.id, r.entity, r.key]),
    [
      [a.fieldId, "contact", "referrer"],
      [b.fieldId, "deal", "referrer"],
      [c.fieldId, "deal", "referrer_2"],
    ],
  );
  assert.match(await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: "referrer", type: "text" })), /already a deal field called Referrer/);
  assert.match(await refusal(addField(ctxFor(db, "add_field"), { entity: "deal", label: " ", type: "text" })), /needs a label/);
});

test("updateField renames without changing the key, adds choices, and archives and restores", async () => {
  const db = await openTestDb();
  const field = await addField(ctxFor(db, "add_field"), {
    entity: "deal",
    label: "Temp",
    type: "choice",
    choices: ["Cold", "Hot"],
  });

  const renamed = await updateField(ctxFor(db, "update_field"), field.fieldId, { label: "Temperature" });
  assert.equal(renamed.summary, `Updated deal field Temp: renamed to Temperature (change ${renamed.changeId})`);
  assert.equal((await listFieldDefs(db))[0]?.key, "temp");

  const grown = await updateField(ctxFor(db, "update_field"), "deal.temp", { choices: ["Cold", "Warm", "Hot"] });
  assert.match(grown.summary, /^Updated deal field Temperature: added the choice Warm \(change /);

  const archived = await updateField(ctxFor(db, "update_field"), "Temperature", { archived: true });
  assert.match(archived.summary, /^Updated deal field Temperature: archived \(change /);
  assert.equal((await listFieldDefs(db)).length, 0);
  assert.equal((await fieldOverview(db, {})).length, 0);
  assert.equal((await fieldOverview(db, { includeArchived: true })).length, 1);
  const restored = await updateField(ctxFor(db, "update_field"), field.fieldId, { archived: false });
  assert.match(restored.summary, /restored/);

  assert.match(await refusal(updateField(ctxFor(db, "update_field"), field.fieldId, {})), /Nothing to change/);
  assert.match(await refusal(updateField(ctxFor(db, "update_field"), "nope", { label: "X" })), /There's no custom field "nope"/);
});

test("removing a choice that records use is refused with a count; an unused choice can go", async () => {
  const db = await openTestDb();
  const field = await addField(ctxFor(db, "add_field"), {
    entity: "deal",
    label: "Temperature",
    type: "choice",
    choices: ["Cold", "Warm", "Hot"],
  });
  for (const name of ["Pat Example", "Robin Sample"]) {
    const lead = await addLead(ctxFor(db, "add_lead"), { name, fields: { temperature: "Warm" } });
    assert.ok(lead.dealId);
  }

  assert.equal(
    await refusal(updateField(ctxFor(db, "update_field"), field.fieldId, { choices: ["Cold", "Hot"] })),
    "Can't remove the choice Warm from Temperature: 2 deals use it. Change those first, or keep the choice.",
  );
  const ok = await updateField(ctxFor(db, "update_field"), field.fieldId, { choices: ["Warm", "Hot"] });
  assert.match(ok.summary, /removed the choice Cold/);
  assert.match(await refusal(updateField(ctxFor(db, "update_field"), field.fieldId, { choices: [] })), /needs choices/);

  const text = await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Notes", type: "text" });
  assert.match(await refusal(updateField(ctxFor(db, "update_field"), text.fieldId, { choices: ["A"] })), /Only choice fields/);
});

test("validateFieldValues checks keys and types, and null clears", () => {
  const defs = [
    def({ key: "budget", label: "Budget", type: "number" }),
    def({ key: "start", label: "Start", type: "date" }),
    def({ key: "temp", label: "Temperature", type: "choice", choices: '["Cold","Hot"]' }),
    def({ key: "memo", label: "Memo", type: "text" }),
    def({ key: "old", label: "Old", type: "text", archived: 1 }),
    def({ key: "budget", label: "Contact budget", entity: "contact", type: "text" }),
  ];
  const check = (values: Record<string, string | number | boolean | null>) => () => validateFieldValues(defs, "deal", values);

  check({ budget: 1500, start: "2026-02-28", temp: "Hot", memo: "x".repeat(500) })();
  check({ budget: null, old: null, ghost: null })();
  assert.throws(check({ ghost: 1 }), /^UserError: Unknown deal field "ghost"\. Add it with add_field first or use one of: budget, start, temp, memo\.$/);
  assert.throws(check({ old: "x" }), /deal field "old" is archived.*update_field/);
  assert.throws(check({ budget: "lots" }), /Budget \(budget\) needs a number, got "lots"/);
  assert.throws(check({ budget: Number.POSITIVE_INFINITY }), /needs a number/);
  assert.throws(check({ budget: true }), /needs a number, got true/);
  assert.throws(check({ start: "2026-02-30" }), /Start \(start\) needs a date like 2026-11-19, got "2026-02-30"/);
  assert.throws(check({ start: "tomorrow" }), /needs a date/);
  assert.throws(check({ temp: "Warm" }), /"Warm" isn't one of the choices for Temperature: Cold, Hot\./);
  assert.throws(check({ memo: 5 }), /Memo \(memo\) needs text, got 5/);
  assert.throws(check({ memo: "x".repeat(501) }), /at most 500 characters \(got 501\)/);
  assert.throws(check({ budget: "lots", ghost: 1 }), /Unknown deal field "ghost"/, "keys are checked before values");
});

test("add_lead, update_contact and update_deal check values against the field types", async () => {
  const db = await openTestDb();
  await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Budget", type: "number" });
  await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Temperature", type: "choice", choices: ["Cold", "Hot"] });
  await addField(ctxFor(db, "add_field"), { entity: "contact", label: "Birthday", type: "date" });

  assert.match(await refusal(addLead(ctxFor(db, "add_lead"), { name: "Lee Example", fields: { budget: "lots" } })), /needs a number/);
  assert.match(
    await refusal(addLead(ctxFor(db, "add_lead"), { name: "Lee Example", contactFields: { birthday: "1990-13-01" } })),
    /needs a date/,
  );
  const lead = await addLead(ctxFor(db, "add_lead"), { name: "Lee Example", fields: { budget: 900 }, contactFields: { birthday: "1990-04-02" } });

  assert.match(await refusal(updateDeal(ctxFor(db, "update_deal"), lead.dealId, { fields: { temperature: "Warm" } })), /isn't one of the choices/);
  assert.match(await refusal(updateContact(ctxFor(db, "update_contact"), lead.contactId, { fields: { birthday: 5 } })), /needs a date/);
  const cleared = await updateDeal(ctxFor(db, "update_deal"), lead.dealId, { fields: { budget: null, temperature: "Hot" } });
  assert.match(cleared.summary, /changed custom fields \(budget, temperature\)/);
});

test("adding and updating a field are each undoable", async () => {
  const db = await openTestDb();
  const field = await addField(ctxFor(db, "add_field"), { entity: "deal", label: "Temp", type: "choice", choices: ["Cold"] });
  const grown = await updateField(ctxFor(db, "update_field"), field.fieldId, { choices: ["Cold", "Hot"], label: "Temperature" });

  const undoneUpdate = await undoChange(ctxFor(db, "undo_change", LATER), grown.changeId);
  assert.match(undoneUpdate.summary, /^Undid chg_[a-z2-7]{12}: Put back the earlier label and choices on field Temp/);
  const [row] = await listFieldDefs(db);
  assert.equal(row?.label, "Temp");
  assert.equal(row?.choices, '["Cold"]');

  const other = await addField(ctxFor(db, "add_field"), { entity: "contact", label: "Referrer", type: "text" });
  const undoneAdd = await undoChange(ctxFor(db, "undo_change", LATER), other.changeId);
  assert.match(undoneAdd.summary, /^Undid chg_[a-z2-7]{12}: Removed field Referrer/);
  assert.equal((await listFieldDefs(db, { includeArchived: true })).length, 1);
});
