// add_lead: someone the owner plans to approach, as a person with status New and no deal (decision 0022). Someone who
// wants something is a deal instead (add-deal.ts). qualify_lead and return_to_lead move a person across the line
// between leads and deals, each in one change (decisions 0022 and 0024).
import type { ActivityRow, ContactRow, Db, DealRow, StageRow, TaskRow } from "../db/db.ts";
import { findContactByEmail, getContact, listStages } from "../db/queries.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, StaleWriteError, updatedRow } from "./change.ts";
import { commitWithEmail } from "./contacts.ts";
import { dealNoun, newDealRow } from "./deal-row.ts";
import { capitalize, joinAnd, nextPart } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkEmail, checkValue, clean, whenOrNull, withoutNulls } from "./input.ts";
import { contactName, contactRef, dealTitle } from "./labels.ts";
import { businessKey, noOpenDeal, openDealCount, withLeadStatus } from "./lead-change.ts";
import { isUnqualified, type LeadStatus, UNQUALIFIED_STATUSES } from "./lead-status.ts";
import { type FieldValues, findContact, findDeal, findStage, firstStageOfKind, ownerTimezone } from "./lookup.ts";
import { LEAD, newPersonColumns } from "./person-move.ts";
import { statusLabels } from "./status-labels.ts";

export interface NewLeadInput {
  /** Needed unless `business` is given; with only a business, the lead is named after it. */
  name?: string;
  business?: string;
  email?: string;
  phone?: string;
  source?: string;
  /** Logged as a note on the person. */
  notes?: string;
  /** Contact custom field values. */
  fields?: FieldValues;
  /** Add the lead even though a person on file has the same business. */
  allowDuplicate?: boolean;
}

export interface AddLeadResult extends ChangeResult {
  contactId: string;
}

/** add_lead refused because the person seems to be on file already; `who` names them safely (labels.ts). */
export class DuplicateLeadError extends UserError {
  readonly by: "email" | "business";
  readonly who: string;
  constructor(message: string, by: "email" | "business", who: string) {
    super(message);
    this.by = by;
    this.who = who;
  }
}

/** The first person on file (not archived) whose business is the same company, ignoring case and spaces. */
async function sameBusiness(db: Db, business: string): Promise<ContactRow | null> {
  const key = businessKey(business);
  if (key === "") return null;
  // SQLite's lower() only folds ASCII, so the comparison is done here, the way companies are grouped (read.ts).
  const found = await db
    .prepare("SELECT * FROM contacts WHERE archived = 0 AND business IS NOT NULL ORDER BY created_at, id")
    .all<ContactRow>();
  return found.results.find((row) => businessKey(row.business) === key) ?? null;
}

export async function addLead(ctx: Ctx, input: NewLeadInput): Promise<AddLeadResult> {
  const { db } = ctx;
  const business = clean(input.business);
  const name = clean(input.name) ?? business;
  if (name === null) throw new UserError("A lead needs a name or a business.");
  const email = clean(input.email);
  if (email !== null) {
    checkEmail(email);
    const other = await findContactByEmail(db, email);
    if (other) {
      const who = capitalize(contactRef(other));
      throw new DuplicateLeadError(
        `${who} already uses that email. Give them a lead status with update_contact, or use add_deal if they want something.`,
        "email",
        who,
      );
    }
  } else if (business !== null && input.allowDuplicate !== true) {
    const other = await sameBusiness(db, business);
    if (other) {
      const who = capitalize(contactRef(other));
      throw new DuplicateLeadError(`${who} already has that business. Say allowDuplicate: true to add another lead anyway.`, "business", who);
    }
  }
  const fields = withoutNulls(input.fields ?? {});
  await checkFieldValues(db, "contact", fields);

  const now = ctx.now.toISOString();
  const contact: ContactRow = {
    id: newId("ct"),
    name,
    email,
    phone: clean(input.phone),
    business,
    source: clean(input.source),
    notes: null,
    fields: JSON.stringify(fields),
    untrusted_fields: "[]",
    archived: 0,
    version: 1,
    created_at: now,
    updated_at: now,
    ...newPersonColumns({ status: LEAD, sub: "new" }, ctx.now),
  };
  const changes: RowChange[] = [{ table: "contacts", id: contact.id, before: null, after: contact }];
  const notes = clean(input.notes);
  if (notes !== null) {
    const note: ActivityRow = {
      id: newId("ac"),
      deal_id: null,
      contact_id: contact.id,
      type: "note",
      summary: notes,
      untrusted_text: null,
      data: null,
      occurred_at: now,
      actor: ctx.actor,
      version: 1,
      created_at: now,
    };
    changes.push({ table: "activities", id: note.id, before: null, after: note });
  }
  const from = contact.source === null ? "" : `, from ${contact.source}`;
  const summary = `Added lead ${name} (${(await statusLabels(db)).lead("new")})${from}`;
  const result = await commitWithEmail(ctx, { target: { table: "contacts", id: contact.id }, summary, changes }, email);
  return { ...result, contactId: contact.id };
}

export interface QualifyInput {
  /** The lead: their id or exact name. */
  contact: string;
  /** Add a deal in the same change (the default), or only set Qualified. */
  createDeal?: boolean;
  /** An open stage by key or label; the default is the first open stage. */
  stage?: string;
  /** The default is "<name> inquiry". */
  dealTitle?: string;
  value?: number;
  nextStep?: string;
  nextAt?: string;
}

export interface QualifyResult extends ChangeResult {
  contactId: string;
  dealId: string | null;
}

/** The stage named, which must be open, or the first open stage. */
async function openStage(db: Db, ref: string | undefined): Promise<StageRow> {
  const stage = ref === undefined ? await firstStageOfKind(db, "open") : await findStage(db, ref);
  if (stage?.kind === "open") return stage;
  const open = (await listStages(db)).filter((s) => s.kind === "open").map((s) => s.label);
  if (stage === null || open.length === 0) {
    throw new UserError("There's no open stage to put a new deal in. Add one with add_stage first.");
  }
  throw new UserError(`${stage.label} isn't an open stage, and a new deal starts in one. The open stages are ${joinAnd(open)}.`);
}

/** A lead becomes Qualified and, unless asked not to, gets a deal in the same change; nothing is copied (0022). */
export async function qualifyLead(ctx: Ctx, input: QualifyInput): Promise<QualifyResult> {
  const { db } = ctx;
  const contact = await findContact(db, input.contact);
  const who = contactName(contact);
  if (contact.archived === 1) throw new UserError(`${capitalize(who)} is archived, so they can't be qualified.`);
  if (!isUnqualified(contact.lead_status)) {
    throw new UserError(`${capitalize(who)} isn't a lead waiting to be qualified. Use add_deal to add a deal for them instead.`);
  }
  const qualified: RowChange = {
    table: "contacts",
    id: contact.id,
    before: contact,
    after: withLeadStatus(contact, "qualified", ctx.now),
  };
  const target = { table: "contacts", id: contact.id } as const;

  if (input.createDeal === false) {
    if ([input.stage, input.dealTitle, input.value, input.nextStep, input.nextAt].some((v) => v !== undefined)) {
      throw new UserError(
        "Deal details only go with a deal. Leave out createDeal: false, or leave out the stage, title, value, next step and next date.",
      );
    }
    const result = await commitChange(ctx, { target, summary: `Qualified ${who} (no deal)`, changes: [qualified] });
    return { ...result, contactId: contact.id, dealId: null };
  }

  const tz = await ownerTimezone(db);
  const value = input.value === undefined ? null : checkValue(input.value);
  const nextStep = clean(input.nextStep);
  const nextAt = whenOrNull(input.nextAt ?? null, tz);
  const stage = await openStage(db, input.stage);
  const deal = newDealRow(
    {
      contactId: contact.id,
      title: clean(input.dealTitle),
      namedAfter: contact,
      stageKey: stage.key,
      value,
      nextStep,
      nextAt,
      fields: {},
      lastActivityAt: null,
    },
    ctx.now,
  );
  const summary = `Qualified ${who}; added ${dealNoun(deal)} in ${stage.label}${nextPart(nextStep, nextAt, tz)}`;
  const result = await commitChange(ctx, {
    target,
    summary,
    changes: [qualified, { table: "deals", id: deal.id, before: null, after: deal }],
  });
  return { ...result, contactId: contact.id, dealId: deal.id };
}

export interface ReturnInput {
  /** The deal: its id, exact title or its contact's exact name. */
  deal: string;
  /** Any status but qualified; the default is contacted. */
  status?: LeadStatus;
}

export interface ReturnResult extends ChangeResult {
  contactId: string;
  dealId: string;
}

/**
 * A deal that was never a real opportunity is archived (its status kept), its open tasks move to the person, and the
 * person gets a lead status, all in one change (0022). Refused while the person has another open deal (invariant 1),
 * which the batch checks again so a deal added at the same moment can't slip past.
 */
export async function returnToLead(ctx: Ctx, input: ReturnInput): Promise<ReturnResult> {
  const { db } = ctx;
  const status = input.status ?? "contacted";
  if (!isUnqualified(status)) {
    const what = status === "qualified" ? "Someone moved back to leads can't be Qualified." : `"${String(status)}" isn't a lead status.`;
    throw new UserError(`${what} Use one of: ${UNQUALIFIED_STATUSES.join(", ")}.`);
  }
  const deal = await findDeal(db, input.deal);
  const title = capitalize(dealTitle(deal));
  if (deal.archived === 1) throw new UserError(`${title} is archived already. Nothing to do.`);
  if (deal.status === "won") {
    throw new UserError(
      `${title} is Won, so it was a real opportunity and can't go back to leads. If it was marked Won by mistake, ` +
        "change its status with update_deal first.",
    );
  }
  const contact = await getContact(db, deal.contact_id);
  if (!contact) throw new Error(`Deal ${deal.id} points at a missing contact.`);
  const who = contactName(contact);
  if (contact.archived === 1) throw new UserError(`${capitalize(who)} is archived, so they can't go back to leads.`);
  await refuseOtherOpenDeal(db, contact, deal);

  const changes: RowChange[] = [{ table: "deals", id: deal.id, before: deal, after: updatedRow(deal, { archived: 1 }, ctx.now) }];
  const open = await db
    .prepare("SELECT * FROM tasks WHERE deal_id = ? AND done_at IS NULL ORDER BY created_at, id")
    .bind(deal.id)
    .all<TaskRow>();
  for (const task of open.results) {
    const moved = updatedRow(task, { deal_id: null, contact_id: contact.id }, ctx.now);
    changes.push({ table: "tasks", id: task.id, before: task, after: moved });
  }
  // The same status again leaves its time alone (decision 0023).
  if (contact.lead_status !== status) {
    changes.push({ table: "contacts", id: contact.id, before: contact, after: withLeadStatus(contact, status, ctx.now) });
  }
  const label = (await statusLabels(db)).lead(status);
  try {
    const result = await commitChange(ctx, {
      target: { table: "deals", id: deal.id },
      summary: `Moved ${who} back to leads (${label}); archived ${dealNoun(deal)}`,
      changes,
      extra: [noOpenDeal(db, contact.id)],
    });
    return { ...result, contactId: contact.id, dealId: deal.id };
  } catch (error) {
    // The guard that tripped may be the open-deal one: then say so, not "changed since".
    if (error instanceof StaleWriteError) await refuseOtherOpenDeal(db, contact, deal);
    throw error;
  }
}

/** Refuses while the person has an open deal other than this one (invariant 1). */
async function refuseOtherOpenDeal(db: Db, contact: ContactRow, deal: DealRow): Promise<void> {
  const others = (await openDealCount(db, contact.id)) - (deal.status === "open" && deal.archived === 0 ? 1 : 0);
  if (others <= 0) return;
  const who = capitalize(contactName(contact));
  throw new UserError(
    others === 1
      ? `${who} has another open deal, so they can't go back to leads. Close it first, then try again.`
      : `${who} has ${others} other open deals, so they can't go back to leads. Close them first, then try again.`,
  );
}
