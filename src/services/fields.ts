// Custom fields on contacts and deals: add_field, update_field, and the check every write that sets field values
// runs (validateFieldValues). A field's key is the slug of its first label and never changes, so renaming keeps the
// values already stored on records.
import type { Db, FieldDefRow, FieldEntity, FieldType } from "../db/db.ts";
import { listFieldDefs } from "../db/queries.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "./change.ts";
import { joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import type { FieldValue, FieldValues } from "./lookup.ts";
import { parseStringArray } from "./lookup.ts";
import { fieldDefRows, type Reader } from "./memo.ts";
import { slugOf, uniqueKey } from "./slug.ts";

const MAX_LABEL = 60;
const MAX_CHOICES = 50;
const MAX_CHOICE = 100;
const MAX_TEXT = 500;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface FieldInput {
  entity: FieldEntity;
  label: string;
  type: FieldType;
  /** Required (and only allowed) for type "choice". */
  choices?: string[];
}

export interface FieldPatch {
  label?: string;
  /** The whole list. It may add choices; it may drop one only when no record uses it. */
  choices?: string[];
  archived?: boolean;
  /** Narrows a lookup by key or label to one entity. */
  entity?: FieldEntity;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const choicesOf = (def: FieldDefRow): string[] => (def.choices === null ? [] : parseStringArray(def.choices));

function cleanLabel(label: string | undefined): string {
  const text = clean(label);
  if (text === null) throw new UserError("A field needs a label. Say what to call it, for example \"Budget\".");
  if (text.length > MAX_LABEL) throw new UserError(`A field label can be at most ${MAX_LABEL} characters (got ${text.length}).`);
  return text;
}

function cleanChoices(choices: string[] | undefined, label: string): string[] {
  const list = (choices ?? []).map((choice) => choice.trim()).filter((choice) => choice !== "");
  if (list.length === 0) {
    throw new UserError(`A choice field needs choices. Give the options for ${label}, for example ["Cold", "Warm", "Hot"].`);
  }
  if (list.length > MAX_CHOICES) throw new UserError(`A choice field can have at most ${MAX_CHOICES} choices (got ${list.length}).`);
  const long = list.find((choice) => choice.length > MAX_CHOICE);
  if (long !== undefined) throw new UserError(`A choice can be at most ${MAX_CHOICE} characters; "${long.slice(0, 20)}…" is longer.`);
  const twice = list.find((choice, index) => list.findIndex((other) => sameText(other, choice)) !== index);
  if (twice !== undefined) throw new UserError(`The choice "${twice}" is listed twice. Give each choice once.`);
  return list;
}

/**
 * The row add_field adds, without writing it: the label checked, the choices cleaned, a clash with a live field of the
 * same label refused, and the key slugged from the label, made unique among `existing` (archived fields included, since
 * a key is never reused). The board import plans a new field with it (decision 0036).
 */
export function newFieldRow(existing: readonly FieldDefRow[], input: FieldInput, now: Date): FieldDefRow {
  const label = cleanLabel(input.label);
  const choices = input.type === "choice" ? cleanChoices(input.choices, label) : null;
  if (input.type !== "choice" && input.choices !== undefined && input.choices.length > 0) {
    throw new UserError(`Only choice fields take choices; ${label} is ${input.type === "number" ? "a number" : `a ${input.type}`} field. Leave choices out.`);
  }
  const mine = existing.filter((f) => f.entity === input.entity);
  const clash = mine.find((f) => f.archived === 0 && sameText(f.label, label));
  if (clash) {
    throw new UserError(`There's already a ${input.entity} field called ${clash.label} (${clash.key}). Pick a different label.`);
  }
  const key = uniqueKey(slugOf(label), new Set(mine.map((f) => f.key)));
  const stamp = now.toISOString();
  return {
    id: newId("fd"),
    entity: input.entity,
    key,
    label,
    type: input.type,
    choices: choices === null ? null : JSON.stringify(choices),
    archived: 0,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  };
}

export async function addField(ctx: Ctx, input: FieldInput): Promise<ChangeResult & { fieldId: string; key: string }> {
  const existing = await listFieldDefs(ctx.db, { entity: input.entity, includeArchived: true });
  const row = newFieldRow(existing, input, ctx.now);
  const choices = row.choices === null ? null : parseStringArray(row.choices);
  const kind = choices === null ? input.type : `choice: ${choices.join(", ")}`;
  const result = await commitChange(ctx, {
    target: { table: "field_defs", id: row.id },
    summary: `Added ${input.entity} field ${row.label} (key ${row.key}, ${kind})`,
    changes: [{ table: "field_defs", id: row.id, before: null, after: row }],
  });
  return { ...result, fieldId: row.id, key: row.key };
}

/** A field by id, "entity.key", or key or label (ignoring case), archived ones included. */
export async function findField(db: Db, ref: string, entity?: FieldEntity): Promise<FieldDefRow> {
  const text = ref.trim();
  const defs = await listFieldDefs(db, { includeArchived: true });
  const byId = defs.find((f) => f.id === text);
  if (byId) return byId;
  const pool = entity === undefined ? defs : defs.filter((f) => f.entity === entity);
  const matches = pool.filter(
    (f) => `${f.entity}.${f.key}` === text.toLowerCase() || f.key === text || sameText(f.label, text),
  );
  const [only, ...others] = matches;
  if (only && others.length === 0) return only;
  if (only) {
    const list = matches.map((f) => `${f.label} (${f.entity}, ${f.id})`).join("; ");
    throw new UserError(`"${text}" matches more than one custom field: ${list}. Use the field id instead.`);
  }
  const list = defs.map((f) => `${f.label} (${f.entity}, ${f.id})`).join("; ");
  throw new UserError(
    `There's no custom field "${text}".${list ? ` Fields: ${list}.` : " There are none yet."} Use list_fields to see them.`,
  );
}

async function usesOfChoice(db: Db, def: FieldDefRow, choice: string): Promise<number> {
  const table = def.entity === "contact" ? "contacts" : "deals";
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE json_extract(fields, ?) = ?`)
    .bind(`$."${def.key}"`, choice)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateField(ctx: Ctx, ref: string, patch: FieldPatch): Promise<ChangeResult & { fieldId: string }> {
  const { db } = ctx;
  const before = await findField(db, ref, patch.entity);
  const set: Partial<FieldDefRow> = {};
  const parts: string[] = [];

  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label);
    const others = await listFieldDefs(db, { entity: before.entity });
    const clash = others.find((f) => f.id !== before.id && sameText(f.label, label));
    if (clash) throw new UserError(`There's already a ${before.entity} field called ${clash.label} (${clash.key}). Pick a different label.`);
    if (label !== before.label) {
      set.label = label;
      parts.push(`renamed to ${label}`);
    }
  }

  if (patch.choices !== undefined) {
    if (before.type !== "choice") {
      throw new UserError(`Only choice fields have choices; ${before.label} is a ${before.type} field. Leave choices out.`);
    }
    const next = cleanChoices(patch.choices, before.label);
    const current = choicesOf(before);
    const removed = current.filter((choice) => !next.includes(choice));
    const added = next.filter((choice) => !current.includes(choice));
    const used: [string, number][] = [];
    for (const choice of removed) {
      const n = await usesOfChoice(db, before, choice);
      if (n > 0) used.push([choice, n]);
    }
    if (used.length > 0) {
      const noun = before.entity === "contact" ? ["contact", "contacts"] : ["deal", "deals"];
      const first = used[0] as [string, number];
      throw new UserError(
        used.length === 1
          ? `Can't remove the choice ${first[0]} from ${before.label}: ${plural(first[1], noun[0] ?? "", noun[1] ?? "")} use${first[1] === 1 ? "s" : ""} it. ` +
              "Change those first, or keep the choice."
          : `Can't remove the choices ${joinAnd(used.map(([choice]) => choice))} from ${before.label}: ` +
              `${used.map(([choice, n]) => `${choice} is used by ${plural(n, noun[0] ?? "", noun[1] ?? "")}`).join("; ")}. ` +
              "Change those first, or keep the choices.",
      );
    }
    if (added.length > 0 || removed.length > 0 || next.some((choice, i) => choice !== current[i])) {
      set.choices = JSON.stringify(next);
      if (added.length > 0) parts.push(`added the ${added.length === 1 ? "choice" : "choices"} ${joinAnd(added)}`);
      if (removed.length > 0) parts.push(`removed the ${removed.length === 1 ? "choice" : "choices"} ${joinAnd(removed)}`);
      if (added.length === 0 && removed.length === 0) parts.push("reordered the choices");
    }
  }

  if (patch.archived !== undefined && (patch.archived ? 1 : 0) !== before.archived) {
    set.archived = patch.archived ? 1 : 0;
    parts.push(patch.archived ? "archived" : "restored");
  }

  if (parts.length === 0) {
    throw new UserError(`Nothing to change on ${before.label}: give a new label, more choices, or archived true or false.`);
  }
  const after = updatedRow(before, set, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "field_defs", id: before.id },
    summary: `Updated ${before.entity} field ${before.label}: ${parts.join("; ")}`,
    changes: [{ table: "field_defs", id: before.id, before, after }],
  });
  return { ...result, fieldId: before.id };
}

function valueText(value: FieldValue): string {
  return typeof value === "string" ? `"${value.length > 40 ? `${value.slice(0, 39)}…` : value}"` : String(value);
}

function isRealDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function checkValue(def: FieldDefRow, value: Exclude<FieldValue, null>): void {
  const name = `${def.label} (${def.key})`;
  const wrong = (needs: string) =>
    new UserError(`The ${def.entity} field ${name} needs ${needs}, got ${valueText(value)}. Fix the value, or leave it out.`);
  switch (def.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw wrong("a number");
      return;
    case "date":
      if (typeof value !== "string" || !isRealDate(value)) throw wrong("a date like 2026-11-19");
      return;
    case "choice": {
      const choices = choicesOf(def);
      if (typeof value !== "string" || !choices.includes(value)) {
        throw new UserError(`${valueText(value)} isn't one of the choices for ${def.label}: ${choices.join(", ")}. Use one of those.`);
      }
      return;
    }
    case "text":
      if (typeof value !== "string") throw wrong("text");
      if (value.length > MAX_TEXT) throw new UserError(`${def.label} can hold at most ${MAX_TEXT} characters (got ${value.length}). Shorten it.`);
  }
}

/**
 * Checks custom field values against the field definitions of one entity: every key must be an active field, and every
 * value must fit the field's type. A null value clears a field and is always allowed. Keys are checked before values.
 */
export function validateFieldValues(defs: FieldDefRow[], entity: FieldEntity, values: FieldValues): void {
  const mine = defs.filter((def) => def.entity === entity);
  const entries = Object.entries(values).filter((entry): entry is [string, Exclude<FieldValue, null>] => entry[1] !== null);
  for (const [key] of entries) {
    const def = mine.find((candidate) => candidate.key === key);
    if (!def) {
      const known = mine.filter((candidate) => candidate.archived === 0).map((candidate) => candidate.key);
      const choices = known.length > 0 ? ` or use one of: ${known.join(", ")}` : "";
      throw new UserError(`Unknown ${entity} field "${key}". Add it with add_field first${choices}.`);
    }
    if (def.archived === 1) {
      throw new UserError(
        `The ${entity} field "${key}" is archived. Bring it back with update_field (archived false) first, or leave it out.`,
      );
    }
  }
  for (const [key, value] of entries) {
    const def = mine.find((candidate) => candidate.key === key);
    if (def) checkValue(def, value);
  }
}

/** validateFieldValues against the database's definitions. */
export async function checkFieldValues(src: Reader, entity: FieldEntity, values: FieldValues): Promise<void> {
  if (Object.values(values).every((value) => value === null)) return;
  validateFieldValues(await fieldDefRows(src, { entity, includeArchived: true }), entity, values);
}

export interface FieldOverview {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  choices: string[] | null;
  archived: boolean;
}

/** list_fields. */
export async function fieldOverview(
  db: Db,
  options: { entity?: FieldEntity; includeArchived?: boolean },
): Promise<FieldOverview[]> {
  return (await listFieldDefs(db, options)).map((def) => ({
    id: def.id,
    entity: def.entity,
    key: def.key,
    label: def.label,
    type: def.type,
    choices: def.type === "choice" ? choicesOf(def) : null,
    archived: def.archived === 1,
  }));
}
