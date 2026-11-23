// The Deals import module (decision 0037): each row is a new deal for a person on file (by contact_id, then email,
// then name plus business) or for a person it adds, unless its `id` names a deal on file, which it fills in (empty
// values only). A person added with a deal is a contact, not a lead, as add_deal adds them; an unqualified lead who
// gets an open deal becomes Qualified in the same change (invariant 1, decision 0022). A deal in a Won, Lost or Not
// now stage comes in only when the owner confirms closed deals as history. Every value from the file is outside text:
// the change lists it in the record's untrusted_fields.
import type { ContactRow, DealRow, DealStatus, StageKind, StageRow } from "../../db/db.ts";
import { isContactId, isDealId, newId } from "../../ids.ts";
import { type ChangeInput, type RowChange, updatedRow } from "../../services/change.ts";
import { withArticle } from "../../services/describe.ts";
import { businessKey, qualifyIfLead } from "../../services/lead-change.ts";
import { isUnqualified } from "../../services/lead-status.ts";
import type { ColumnDef, ImportModule, ImportOptions, MappedRow, PlanBase } from "../engine.ts";
import {
  checkedFields,
  EMAIL,
  emailKey,
  fieldInputs,
  idList,
  isEmptyValue,
  nameKey,
  readAmount,
  readWhen,
  storedFields,
} from "./values.ts";

/** The same limits the MCP tools apply (src/mcp/schemas.ts). Stage, status, value, dates and ids are read, not kept. */
const DEAL_COLUMNS: readonly ColumnDef[] = [
  { key: "id", label: "Deal id", aliases: [], multiline: false },
  { key: "title", label: "Title", aliases: [], limit: 500, multiline: false, required: true },
  { key: "contact_id", label: "Contact id", aliases: [], multiline: false },
  { key: "email", label: "Email", aliases: [], limit: 254, multiline: false },
  { key: "name", label: "Name", aliases: [], limit: 500, multiline: false },
  { key: "business", label: "Business", aliases: [], limit: 500, multiline: false },
  { key: "stage", label: "Stage", aliases: ["stage_key"], multiline: false },
  { key: "status", label: "Status", aliases: [], multiline: false },
  { key: "value", label: "Value", aliases: [], multiline: false },
  { key: "next_step", label: "Next step", aliases: ["next step"], limit: 500, multiline: false },
  { key: "next_at", label: "Next date", aliases: ["next date"], multiline: false },
];

/** The board export's deals columns that are bookkeeping: recognised and never imported. */
const DEAL_IGNORED = ["fields", "stage_entered_at", "last_activity_at", "untrusted_fields", "archived", "version", "created_at", "updated_at"];

/** What a deals plan reads: every contact and stage, the deals the file's ids name, and the owner's timezone. */
export interface DealsCtx {
  contacts: readonly ContactRow[];
  /** Only the deals whose id is in the file (dealsOnFile in src/import/load.ts). */
  deals: readonly DealRow[];
  stages: readonly StageRow[];
  tz: string;
}

export interface DealsOptions extends ImportOptions {
  /** Bring in deals in a Won, Lost or Not now stage; without it they are skipped. */
  closedAsHistory: boolean;
}

/** A person the import adds for a deal: a contact (not a lead), with the row's name, email and business. */
export interface NewPerson {
  line: number;
  /** A well-formed contact_id from the file that matches nobody, kept for the new contact; null for a new id. */
  id: string | null;
  name: string;
  email: string | null;
  business: string | null;
}

export interface DealCreate {
  line: number;
  /** A well-formed deal id from the file that matches no deal, kept; null for a new id. */
  id: string | null;
  /** A contact on file by id, or the index of a person this import adds (DealsPlan.people). */
  person: { onFile: string } | { added: number };
  title: string;
  stageKey: string;
  status: DealStatus;
  value: number | null;
  nextStep: string | null;
  nextAt: string | null;
  fields: Record<string, string | number>;
}

export interface DealMerge {
  id: string;
  line: number;
  changes: Partial<{ value: number; next_step: string; next_at: string }>;
  /** Custom fields that were empty on the deal and are filled from the file, by field key. */
  fields?: Record<string, string | number>;
}

export interface DealsPlan extends PlanBase {
  create: DealCreate[];
  people: NewPerson[];
  /** Contacts on file who are unqualified leads and get an open deal: Qualified in the same change. */
  qualify: string[];
  merge: DealMerge[];
  unchanged: { line: number; id: string }[];
  /** Every new deal in a closed stage, confirmed or not (unconfirmed ones are also in `skipped`). */
  closed: { line: number; stageKey: string }[];
}

const STATUS_WORDS: Record<StageKind, string> = { open: "open", won: "won", lost: "lost", not_now: "not now" };

function statusOf(text: string): DealStatus | null {
  const key = text.trim().toLowerCase().replace(/\s+/g, "_");
  return key === "open" || key === "won" || key === "lost" || key === "not_now" ? key : null;
}

type Resolved = { kind: "skip"; reason: string } | { kind: "onFile"; contact: ContactRow } | { kind: "added"; index: number } | { kind: "new" };

const personKey = (name: string | null, business: string | null) => `${nameKey(name)}\u0000${businessKey(business)}`;

/** Rows over a column's limit never reach the plan: planRows (src/import/engine.ts) skips them first. */
export function planDeals(rows: readonly MappedRow[], ctx: DealsCtx, options: DealsOptions): DealsPlan {
  const live = ctx.stages.filter((stage) => stage.archived === 0).sort((a, b) => a.position - b.position);
  const dealsById = new Map(ctx.deals.map((deal) => [deal.id, deal]));
  const byId = new Map(ctx.contacts.map((contact) => [contact.id, contact]));
  const byEmail = new Map<string, ContactRow>();
  const byPerson = new Map<string, ContactRow[]>();
  for (const contact of ctx.contacts) {
    if (contact.email) byEmail.set(emailKey(contact.email), contact);
    if (contact.archived === 1) continue;
    const key = personKey(contact.name, contact.business);
    byPerson.set(key, [...(byPerson.get(key) ?? []), contact]);
  }
  // The people this file adds, so a second deal for one of them finds them the same way.
  const addedById = new Map<string, number>();
  const addedByEmail = new Map<string, number>();
  const addedByPerson = new Map<string, number>();
  const seenIds = new Map<string, number>();
  const plan: DealsPlan = { create: [], people: [], qualify: [], merge: [], unchanged: [], skipped: [], closed: [] };

  const resolve = (values: MappedRow["values"], contactId: string | null): Resolved => {
    if (contactId !== null) {
      const onFile = byId.get(contactId);
      if (onFile) return onFile.archived === 1 ? { kind: "skip", reason: `contact ${onFile.id} is archived` } : { kind: "onFile", contact: onFile };
      const added = addedById.get(contactId);
      if (added !== undefined) return { kind: "added", index: added };
    }
    const email = values.email ?? null;
    if (email !== null) {
      if (!EMAIL.test(email)) return { kind: "skip", reason: "the email doesn't look like an email address" };
      const onFile = byEmail.get(emailKey(email));
      if (onFile) return onFile.archived === 1 ? { kind: "skip", reason: `contact ${onFile.id} is archived` } : { kind: "onFile", contact: onFile };
      const added = addedByEmail.get(emailKey(email));
      if (added !== undefined) return { kind: "added", index: added };
    }
    const name = values.name ?? null;
    if (name === null) return { kind: "skip", reason: "no person matches and there's no name to add one" };
    const key = personKey(name, values.business ?? null);
    const matches = byPerson.get(key) ?? [];
    const [only, ...others] = matches;
    if (only && others.length > 0) {
      return { kind: "skip", reason: `more than one person on file has this name and business (${idList("contact", matches.map((c) => c.id))})` };
    }
    if (only) return { kind: "onFile", contact: only };
    const added = addedByPerson.get(key);
    return added === undefined ? { kind: "new" } : { kind: "added", index: added };
  };

  for (const row of rows) {
    const { line, values } = row;
    const skip = (reason: string) => plan.skipped.push({ line, reason });
    const title = values.title ?? null;
    if (title === null) {
      skip("no title");
      continue;
    }
    const idText = values.id ?? null;
    const id = idText !== null && isDealId(idText) ? idText : null;
    if (id !== null) {
      const earlier = seenIds.get(id);
      if (earlier !== undefined) {
        skip(`the same id as line ${earlier}`);
        continue;
      }
      seenIds.set(id, line);
    }
    const valueText = values.value ?? null;
    const value = valueText === null ? null : readAmount(valueText);
    if (valueText !== null && value === null) {
      skip("value needs a number of 0 or more");
      continue;
    }
    const nextAtText = values.next_at ?? null;
    const nextAt = nextAtText === null ? null : readWhen(nextAtText, ctx.tz);
    if (nextAtText !== null && nextAt === null) {
      skip("next_at isn't a date like 2026-11-19");
      continue;
    }
    const nextStep = values.next_step ?? null;
    const given = fieldInputs(row.fields, options.fieldDefs, "deal");

    const match = id === null ? undefined : dealsById.get(id);
    if (match) {
      if (match.archived === 1) {
        skip(`deal ${match.id} is archived`);
        continue;
      }
      const stored = storedFields(match.fields);
      const { fields: filled, problem } = checkedFields(given.filter(({ def }) => isEmptyValue(stored[def.key])), "deal");
      if (problem !== null) {
        skip(problem);
        continue;
      }
      const changes: DealMerge["changes"] = {};
      if (value !== null && match.value === null) changes.value = value;
      if (nextStep !== null && isEmptyValue(match.next_step)) changes.next_step = nextStep;
      if (nextAt !== null && match.next_at === null) changes.next_at = nextAt;
      const merged: DealMerge = { id: match.id, line, changes };
      if (Object.keys(filled).length > 0) merged.fields = filled;
      if (Object.keys(changes).length > 0 || merged.fields) plan.merge.push(merged);
      else plan.unchanged.push({ line, id: match.id });
      continue;
    }

    // A new deal: its stage (by key or label) and its status follow each other, as in update_deal.
    const stageText = values.stage ?? null;
    const statusText = values.status ?? null;
    let stage: StageRow | undefined;
    if (stageText !== null) {
      stage = live.find((s) => s.key === stageText) ?? live.find((s) => s.label.toLowerCase() === stageText.toLowerCase());
      if (!stage) {
        skip(`stage isn't one of your stages: ${live.map((s) => s.label).join(", ")}`);
        continue;
      }
    }
    const status = statusText === null ? null : statusOf(statusText);
    if (statusText !== null && status === null) {
      skip("status isn't a deal status. Use open, won, lost or not_now");
      continue;
    }
    if (stage && status !== null && stage.kind !== status) {
      skip(`status doesn't match the stage (${stage.label} is ${withArticle(STATUS_WORDS[stage.kind])} stage)`);
      continue;
    }
    if (!stage) {
      const kind = status ?? "open";
      stage = live.find((s) => s.kind === kind);
      if (!stage) {
        skip(`there's no ${STATUS_WORDS[kind]} stage to put it in`);
        continue;
      }
    }
    const { fields, problem } = checkedFields(given, "deal");
    if (problem !== null) {
      skip(problem);
      continue;
    }
    const contactText = values.contact_id ?? null;
    const contactId = contactText !== null && isContactId(contactText) ? contactText : null;
    const person = resolve(values, contactId);
    if (person.kind === "skip") {
      skip(person.reason);
      continue;
    }
    if (stage.kind !== "open") {
      plan.closed.push({ line, stageKey: stage.key });
      if (!options.closedAsHistory) {
        skip("closed deal, not confirmed");
        continue;
      }
    }
    let ref: DealCreate["person"];
    if (person.kind === "onFile") {
      ref = { onFile: person.contact.id };
      if (stage.kind === "open" && isUnqualified(person.contact.lead_status) && !plan.qualify.includes(person.contact.id)) {
        plan.qualify.push(person.contact.id);
      }
    } else if (person.kind === "added") {
      ref = { added: person.index };
    } else {
      const index = plan.people.length;
      const email = values.email ?? null;
      plan.people.push({ line, id: contactId, name: values.name ?? "", email, business: values.business ?? null });
      if (contactId !== null) addedById.set(contactId, index);
      if (email !== null) addedByEmail.set(emailKey(email), index);
      addedByPerson.set(personKey(values.name ?? null, values.business ?? null), index);
      ref = { added: index };
    }
    plan.create.push({ line, id, person: ref, title, stageKey: stage.key, status: stage.kind, value, nextStep, nextAt, fields });
  }
  return plan;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 deals come in as Won, 1 as Lost": the closed deals by stage, in stage order; "" when there are none. */
export function closedSentence(closed: DealsPlan["closed"], stages: readonly StageRow[]): string {
  const counts = new Map<string, number>();
  for (const row of closed) counts.set(row.stageKey, (counts.get(row.stageKey) ?? 0) + 1);
  const parts = [...stages]
    .sort((a, b) => a.position - b.position)
    .filter((stage) => counts.has(stage.key))
    .map((stage, i) => {
      const n = counts.get(stage.key) ?? 0;
      return i === 0 ? `${plural(n, "deal comes", "deals come")} in as ${stage.label}` : `${n} as ${stage.label}`;
    });
  return parts.join(", ");
}

/** Counts only: an import's summary never quotes what the file held. */
export function dealsSummary(created: number, filled: number, people: number, qualified: number): string {
  return (
    `Imported ${plural(created, "deal", "deals")} and filled details on ${filled}` +
    (people > 0 ? `; added ${plural(people, "contact", "contacts")}` : "") +
    (qualified > 0 ? `; ${plural(qualified, "lead is", "leads are")} now Qualified` : "")
  );
}

/** The change for a plan, or null when it would write nothing. */
export function dealsChange(plan: DealsPlan, ctx: DealsCtx, now: Date): ChangeInput | null {
  const stamp = now.toISOString();
  const changes: RowChange[] = [];
  const addedIds = plan.people.map((person) => {
    const contact: ContactRow = {
      id: person.id ?? newId("ct"),
      name: person.name,
      email: person.email,
      phone: null,
      business: person.business,
      source: null,
      notes: null,
      fields: "{}",
      untrusted_fields: JSON.stringify(["name", ...(person.email === null ? [] : ["email"]), ...(person.business === null ? [] : ["business"])]),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      lead_status: null,
      lead_status_at: null,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
    return contact.id;
  });
  const contacts = new Map(ctx.contacts.map((contact) => [contact.id, contact]));
  for (const id of plan.qualify) {
    const contact = contacts.get(id);
    if (!contact) throw new Error(`The import plan names contact ${id}, which wasn't read.`);
    const qualified = qualifyIfLead(contact, now);
    if (qualified !== null) changes.push(qualified);
  }
  for (const row of plan.create) {
    const contactId = "onFile" in row.person ? row.person.onFile : addedIds[row.person.added];
    if (contactId === undefined) throw new Error(`The import plan's line ${row.line} names a person it doesn't add.`);
    const outside = [
      "title",
      ...(row.value === null ? [] : ["value"]),
      ...(row.nextStep === null ? [] : ["next_step"]),
      ...(row.nextAt === null ? [] : ["next_at"]),
      ...Object.keys(row.fields),
    ];
    const deal: DealRow = {
      id: row.id ?? newId("dl"),
      contact_id: contactId,
      title: row.title,
      stage_key: row.stageKey,
      value: row.value,
      next_step: row.nextStep,
      next_at: row.nextAt,
      status: row.status,
      fields: JSON.stringify(row.fields),
      // A closed deal from the file enters its stage now: the export's stage_entered_at is bookkeeping (decision 0037).
      stage_entered_at: stamp,
      last_activity_at: null,
      untrusted_fields: JSON.stringify(outside),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    changes.push({ table: "deals", id: deal.id, before: null, after: deal });
  }
  const deals = new Map(ctx.deals.map((deal) => [deal.id, deal]));
  for (const { id, changes: filled, fields } of plan.merge) {
    const before = deals.get(id);
    if (!before) throw new Error(`The import plan names deal ${id}, which wasn't read.`);
    const untrusted = new Set(JSON.parse(before.untrusted_fields) as string[]);
    for (const column of [...Object.keys(filled), ...Object.keys(fields ?? {})]) untrusted.add(column);
    const patch: Partial<DealRow> = { ...filled, untrusted_fields: JSON.stringify([...untrusted]) };
    if (fields) patch.fields = JSON.stringify({ ...storedFields(before.fields), ...fields });
    changes.push({ table: "deals", id, before, after: updatedRow(before, patch, now) });
  }
  const first = changes.find((change) => change.table === "deals");
  if (!first) return null;
  const qualified = changes.filter((change) => change.table === "contacts" && change.before !== null).length;
  return {
    target: { table: "deals", id: first.id },
    summary: dealsSummary(plan.create.length, plan.merge.length, plan.people.length, qualified),
    changes,
    // One change at any size (decision 0035).
    bulk: true,
  };
}

/** Deals, each for a person on file or one it adds; matched to a deal on file only by id. */
export const dealsModule: ImportModule<DealsCtx, DealsPlan, DealsOptions> = {
  key: "deals",
  noun: { one: "deal", many: "deals" },
  entity: "deal",
  notes: false,
  columns: DEAL_COLUMNS,
  ignored: DEAL_IGNORED,
  plan: planDeals,
  change: dealsChange,
};
