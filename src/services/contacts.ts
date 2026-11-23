// update_contact, and the duplicate-email answer every write that adds or changes an email shares.
import type { ContactRow, Db, TaskRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import { formatLocal, localWhen, parseWhen } from "../time.ts";
import {
  type ChangeInput,
  type ChangeResult,
  changedColumns,
  commitChange,
  type Ctx,
  isDuplicateEmailFailure,
  type Row,
  type RowChange,
  StaleWriteError,
  updatedRow,
} from "./change.ts";
import { capitalize, columnLabel, fieldsLabel, joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkEmail, clean } from "./input.ts";
import { contactName, isTrusted, taskTitle } from "./labels.ts";
import { followUpTask, noOpenDeal, openDealCount } from "./lead-change.ts";
import { isLeadStatus, isUnqualified, type LeadStatus } from "./lead-status.ts";
import { type FieldValues, findContact, mergeFields, ownerTimezone, parseObject, parseStringArray } from "./lookup.ts";
import { LEAD, moveForLeadStatus, personStatusPatch } from "./person-move.ts";
import { resolveMove } from "./person-status.ts";
import { statusLabels } from "./status-labels.ts";

/** commitChange, with a duplicate email that another writer got in first turned into a plain answer. */
export async function commitWithEmail(ctx: Ctx, input: ChangeInput, email: string | null): Promise<ChangeResult> {
  try {
    return await commitChange(ctx, input);
  } catch (error) {
    if (email === null || !isDuplicateEmailFailure(error)) throw error;
    const other = await findContactByEmail(ctx.db, email);
    const who = other ? `: contact ${other.id}` : "";
    throw new UserError(`Another contact already uses that email${who}. Use update_contact on that one instead.`, {
      cause: error,
    });
  }
}

export interface ContactPatch {
  name?: string;
  email?: string | null;
  phone?: string | null;
  business?: string | null;
  source?: string | null;
  notes?: string | null;
  /** Merged into the stored values; null removes a key. */
  fields?: FieldValues;
  /** Any status but qualified (qualify_lead does that), and an unqualified one only while they have no open deal. */
  leadStatus?: LeadStatus;
  /** With the Not now status: adds the task "Check back with {contact}" due then. Read in the owner's timezone. */
  followUpDate?: string;
  /**
   * A live person status, by key or label (decision 0041); Lead only while they have no open deal. Not with
   * `leadStatus`.
   */
  personStatus?: string;
  /** One of the status's live sub-statuses, by key or label; null for none. Left out: see resolveMove. */
  subStatus?: string | null;
}

const OPTIONAL_COLUMNS = ["email", "phone", "business", "source", "notes"] as const;

/** Refuses a value that is no lead status, and an unqualified one while the person has an open deal (invariant 1). */
async function checkLeadStatus(ctx: Ctx, contact: ContactRow, status: LeadStatus): Promise<void> {
  if (!isLeadStatus(status) || !isUnqualified(status)) {
    throw new UserError(`"${String(status)}" isn't a lead status. Use one of: new, contacted, not_now, not_a_fit, bad.`);
  }
  const open = await openDealCount(ctx.db, contact.id);
  if (open === 0) return;
  const who = capitalize(contactName(contact));
  throw new UserError(
    open === 1
      ? `${who} has 1 open deal. Use return_to_lead on that deal instead, or close it first.`
      : `${who} has ${open} open deals. Close them first, or close all but one and use return_to_lead on that one.`,
  );
}

/** True when the person already has an open "Check back" task with this title and due time. */
async function openCheckBack(db: Db, contactId: string, task: TaskRow): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS one FROM tasks WHERE contact_id = ? AND deal_id IS NULL AND title = ? AND due_at = ? AND done_at IS NULL LIMIT 1")
    .bind(contactId, task.title, task.due_at)
    .first<{ one: number }>();
  return found !== null;
}

/** "Fri Dec 4" for a date given without a time (midnight), else "Fri Dec 4, 10:30 AM". */
function dueText(due: Date, tz: string): string {
  const shown = formatLocal(due, tz);
  return localWhen(due, tz).includes("T") ? shown : (shown.split(",")[0] ?? shown);
}

/**
 * Every field this sets is the owner's word from now on, so it leaves `untrusted_fields`. A lead status (decision 0022)
 * goes with the time it changed; Not now with a follow-up date adds the "Check back" task in the same change.
 */
export async function updateContact(ctx: Ctx, contactRef: string, patch: ContactPatch): Promise<ChangeResult> {
  const { db } = ctx;
  const before = await findContact(db, contactRef);
  const set: Row = {};
  const confirmed: string[] = [];

  if (patch.name !== undefined) {
    const name = clean(patch.name);
    if (name === null) throw new UserError("A contact's name can't be blank. Give the new name.");
    set.name = name;
    confirmed.push("name");
  }
  for (const column of OPTIONAL_COLUMNS) {
    if (patch[column] === undefined) continue;
    const value = clean(patch[column]);
    if (column === "email" && value !== null) {
      checkEmail(value);
      const other = await findContactByEmail(db, value);
      if (other && other.id !== before.id) {
        throw new UserError(
          `${isTrusted(other, "name") ? `${other.name} (${other.id})` : `contact ${other.id}`} already uses ` +
            `${isTrusted(other, "email") ? other.email : value}. Use a different email, or update that contact instead.`,
        );
      }
    }
    set[column] = value;
    confirmed.push(column);
  }
  if (patch.fields !== undefined) {
    await checkFieldValues(db, "contact", patch.fields);
    set.fields = mergeFields(before.fields, patch.fields);
    confirmed.push(...Object.keys(patch.fields).map((key) => `fields.${key}`));
  }
  const byStatus = patch.personStatus !== undefined || patch.subStatus !== undefined;
  if (byStatus && patch.leadStatus !== undefined) {
    throw new UserError("Give either leadStatus or personStatus and subStatus, not both. For a lead, personStatus lead with subStatus does the same.");
  }
  if (patch.leadStatus === "qualified") {
    throw new UserError("Use qualify_lead to make a lead a contact; it can add the deal too.");
  }
  // The same status again leaves its time alone, so on its own it changes nothing.
  if (patch.leadStatus !== undefined && patch.leadStatus !== before.lead_status) {
    if (before.archived === 1) {
      throw new UserError(`${capitalize(contactName(before))} is archived, so they can't be given a lead status.`);
    }
    await checkLeadStatus(ctx, before, patch.leadStatus);
    // Lead with this sub-status, through the one function that keeps both pairs of columns in step (decision 0040).
    Object.assign(set, personStatusPatch(before, moveForLeadStatus(before, patch.leadStatus), ctx.now));
  }
  if (byStatus) {
    if (before.archived === 1) throw new UserError(`${capitalize(contactName(before))} is archived, so their status can't change.`);
    const { move } = await resolveMove(db, before, { status: patch.personStatus ?? before.person_status, sub: patch.subStatus });
    if (move.status !== before.person_status || move.sub !== before.sub_status) {
      // Lead is refused while they have an open deal (invariant 1), and checked again inside the batch below.
      if (move.status === LEAD && move.sub !== null) await checkLeadStatus(ctx, before, move.sub as LeadStatus);
      Object.assign(set, personStatusPatch(before, move, ctx.now));
    }
  }
  const followUp = clean(patch.followUpDate);
  const tz = await ownerTimezone(db);
  const leadAfter = "lead_status" in set ? (set.lead_status as LeadStatus | null) : before.lead_status;
  if (followUp !== null && leadAfter !== "not_now") {
    throw new UserError(
      "A follow-up date only goes with the Not now status. Give leadStatus not_now too, or add a task with add_task instead.",
    );
  }
  const due = followUp === null ? null : parseWhen(followUp, tz);
  const untrusted = parseStringArray(before.untrusted_fields);
  const remaining = untrusted.filter((field) => !confirmed.includes(field));
  if (remaining.length !== untrusted.length) set.untrusted_fields = JSON.stringify(remaining);

  const after = updatedRow(before, set as Partial<ContactRow>, ctx.now);
  // Built from the updated row, so a rename in the same call names the task (and its trust) after the new name.
  let task: TaskRow | null = due === null ? null : followUpTask(after, due, ctx.now);
  // The same request twice (a double post) must not stack a second identical check-back.
  if (task !== null && (await openCheckBack(db, before.id, task))) task = null;
  const changed = changedColumns(before, after).filter((c) => !["version", "updated_at", "lead_status_at"].includes(c));
  if (changed.length === 0 && task === null) {
    throw new UserError(`Nothing to change for ${contactName(before)}: every value you gave is already set.`);
  }

  // The contact row goes in even when only a task is added (its version still moves), so its guard applies: a status
  // changed by another write since this read fails the change instead of adding a "Check back" task for a non-Not now.
  const changes: RowChange[] = [{ table: "contacts", id: before.id, before, after }];
  if (task !== null) changes.push({ table: "tasks", id: task.id, before: null, after: task });
  const who = contactName(after);
  // A move by person status says where to, by the owner's labels; a lead status alone says that, as before.
  const moved = changed.includes("person_status") || changed.includes("sub_status");
  const names = moved || changed.includes("lead_status") ? await statusLabels(db) : null;
  const status =
    names === null
      ? []
      : byStatus && moved
        ? [`person status to ${names.both(after.person_status, after.sub_status)}`]
        : after.lead_status !== null && changed.includes("lead_status")
          ? [`lead status to ${names.lead(after.lead_status)}`]
          : [];
  const labels = changed
    .filter((c) => !["untrusted_fields", "lead_status", "person_status", "sub_status"].includes(c))
    .map((c) => (c === "fields" ? fieldsLabel(parseObject(before.fields), parseObject(after.fields)) : columnLabel(c)));
  const confirmedOnly = untrusted.filter((field) => confirmed.includes(field));
  const head =
    status.length + labels.length > 0
      ? `Updated ${who}: ${joinAnd([...status, ...labels])}`
      : changed.length > 0
        ? `Confirmed ${joinAnd(confirmedOnly.map(columnLabel))} for ${who}`
        : null;
  let summary = head ?? "";
  if (task !== null) {
    const named = isTrusted(task, "title") ? `task ${taskTitle(task)}` : taskTitle(task);
    const due = dueText(new Date(task.due_at ?? ""), tz);
    summary = head === null ? `Added ${named} for ${who}, due ${due}` : `${head}; added ${named}, due ${due}`;
  }
  // Setting an unqualified status checks "no open deal" again inside the batch, so a deal added at the same moment
  // (which doesn't touch the contact row) can't slip past (invariant 1), the way return_to_lead does.
  const extra = isUnqualified(after.lead_status) && changed.includes("lead_status") ? [noOpenDeal(db, before.id)] : [];
  try {
    return await commitWithEmail(
      ctx,
      { target: { table: "contacts", id: before.id }, summary, changes, extra },
      typeof set.email === "string" ? set.email : null,
    );
  } catch (error) {
    // The guard that tripped may be the open-deal one: then say so, not "changed since".
    if (error instanceof StaleWriteError && after.lead_status !== null && extra.length > 0) {
      await checkLeadStatus(ctx, before, after.lead_status);
    }
    throw error;
  }
}
