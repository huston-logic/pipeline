// Write tools (readOnlyHint: false). Each one is a single audited change made as the "ai" actor, and answers with
// the service's one-line summary, which ends with "(change chg_...)", then the new ids as JSON.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONTACT_TYPES } from "../services/activities.ts";
import { logActivity } from "../services/activities.ts";
import type { Ctx } from "../services/change.ts";
import { updateDeal } from "../services/deals.ts";
import { addLead, updateContact } from "../services/leads.ts";
import { addTask } from "../services/tasks.ts";
import { undoChange } from "../services/undo.ts";
import { toolResult } from "./format.ts";
import { contactRef, DEAL_STATUSES, dealRef, fieldValues, longText, orNull, shortText, when } from "./schemas.ts";
import { registerTool, type ToolDeps } from "./tool.ts";

const aiCtx = ({ db, now }: ToolDeps, tool: string): Ctx => ({ db, now: now(), actor: "ai", tool });

/** Owner-loggable activity types: the contact types without "form", which only comes in through /intake. */
const LOGGABLE = CONTACT_TYPES.filter((type) => type !== "form") as ["email", "call", "meeting", "note"];

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  registerTool(
    server,
    {
      name: "add_lead",
      title: "Add a lead",
      kind: "write",
      description:
        "Adds a lead: a contact (or the existing contact with the same email) and a new deal in the first open stage. " +
        "Notes are logged as a note on the deal.",
      input: z.strictObject({
        name: shortText("The person's name."),
        email: shortText("Their email address. A contact already using it gets the new deal.").optional(),
        phone: shortText("Their phone number.").optional(),
        business: shortText("Their business name.").optional(),
        source: shortText("Where the lead came from, for example \"referral\" or \"trade fair\".").optional(),
        notes: longText("What they want, in a few words; logged as a note on the deal.").optional(),
        dealTitle: shortText("The deal's title; the default is \"<name> inquiry\".").optional(),
        value: z.number().min(0).optional().describe("The deal's value, a number of 0 or more."),
        nextStep: shortText("The next step, for example \"Send a quote\".").optional(),
        nextAt: when("When the next step is due").optional(),
        fields: fieldValues("deal").optional(),
        contactFields: fieldValues("contact").optional(),
      }),
      async run(args, deps) {
        const result = await addLead(aiCtx(deps, "add_lead"), args);
        const { changeId, contactId, dealId, matchedExisting } = result;
        return toolResult(result.summary, { changeId, contactId, dealId, matchedExisting });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_contact",
      title: "Update a contact",
      kind: "write",
      idempotent: true,
      description:
        "Changes a contact's details. Give only what changes; null clears an optional value. Every value you set " +
        "counts as confirmed by the owner, so it leaves the contact's untrusted_fields.",
      input: z.strictObject({
        contact: contactRef(),
        name: shortText("The new name.").optional(),
        email: orNull(shortText("The new email address, or null to clear it.")).optional(),
        phone: orNull(shortText("The new phone number, or null to clear it.")).optional(),
        business: orNull(shortText("The new business name, or null to clear it.")).optional(),
        source: orNull(shortText("Where the lead came from, or null to clear it.")).optional(),
        notes: orNull(longText("Notes about the person, or null to clear them.")).optional(),
        fields: fieldValues("contact").optional(),
      }),
      async run({ contact, ...patch }, deps) {
        const result = await updateContact(aiCtx(deps, "update_contact"), contact, patch);
        return toolResult(result.summary, { changeId: result.changeId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_deal",
      title: "Update a deal",
      kind: "write",
      idempotent: true,
      description:
        "Moves a deal to another stage or changes its title, value, next step, next date or custom fields. A won, lost " +
        "or not now stage sets the status, and the status moves the deal to that kind of stage. Ask the owner before " +
        "marking a deal Won, Lost or Not now. Give only what changes; null clears an optional value.",
      input: z.strictObject({
        deal: dealRef(),
        stage: shortText("The stage to move to: its key (call_booked) or label (Call booked).").optional(),
        status: z.enum(DEAL_STATUSES).optional().describe("The new status. Ask the owner before won, lost or not_now."),
        title: shortText("The new title.").optional(),
        value: z.number().min(0).nullable().optional().describe("The deal's value, a number of 0 or more, or null to clear it."),
        nextStep: orNull(shortText("The next step, or null to clear it.")).optional(),
        nextAt: orNull(when("When the next step is due, or null to clear it")).optional(),
        fields: fieldValues("deal").optional(),
      }),
      async run({ deal, ...patch }, deps) {
        const result = await updateDeal(aiCtx(deps, "update_deal"), deal, patch);
        return toolResult(result.summary, { changeId: result.changeId, dealId: result.dealId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "log_activity",
      title: "Log an activity",
      kind: "write",
      description:
        "Records something that happened with a contact: an email, call, meeting or note. Give a deal, a contact, or " +
        "both. Stage moves are recorded by update_deal, not here.",
      input: z.strictObject({
        deal: dealRef().optional(),
        contact: contactRef().optional(),
        type: z.enum(LOGGABLE).describe("What kind of contact it was."),
        summary: longText("What happened, in a sentence or two."),
        occurredAt: when("When it happened; the default is now. It can't be in the future").optional(),
      }),
      async run({ deal, contact, ...rest }, deps) {
        const result = await logActivity(aiCtx(deps, "log_activity"), { dealId: deal, contactId: contact, ...rest });
        return toolResult(result.summary, { changeId: result.changeId, activityId: result.activityId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_task",
      title: "Add a task",
      kind: "write",
      description: "Adds a to-do or reminder for a deal or a contact, with an optional due time.",
      input: z.strictObject({
        deal: dealRef().optional(),
        contact: contactRef().optional(),
        title: shortText("What to do, in a few words."),
        dueAt: when("When it is due").optional(),
      }),
      async run({ deal, contact, ...rest }, deps) {
        const result = await addTask(aiCtx(deps, "add_task"), { dealId: deal, contactId: contact, ...rest });
        return toolResult(result.summary, { changeId: result.changeId, taskId: result.taskId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "undo_change",
      title: "Undo a change",
      kind: "write",
      destructive: true,
      idempotent: true,
      description:
        "Reverses exactly one change by its id (from a write's answer or recent_changes), as a new change. Undoing an " +
        "add removes what it added. Refuses if the change was already undone or a record it touched changed since.",
      input: z.strictObject({ changeId: z.string().min(1).max(100).describe("The change id, chg_...") }),
      async run({ changeId }, deps) {
        const result = await undoChange(aiCtx(deps, "undo_change"), changeId);
        return toolResult(result.summary, { changeId: result.changeId, undid: changeId.trim() });
      },
    },
    deps,
  );
}
