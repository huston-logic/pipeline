// Write tools (readOnlyHint: false). Each one is a single audited change made as the "ai" actor, and answers with
// the service's one-line summary, which ends with "(change chg_...)", then the new ids as JSON.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONTACT_TYPES } from "../services/activities.ts";
import { logActivity } from "../services/activities.ts";
import type { Ctx } from "../services/change.ts";
import { updateDeal } from "../services/deals.ts";
import { addField, updateField } from "../services/fields.ts";
import { addLead, updateContact } from "../services/leads.ts";
import { updateRulebook } from "../services/rulebook.ts";
import { addRule, pauseRule, resumeRule, updateRule } from "../services/rules.ts";
import { updateSettings } from "../services/settings.ts";
import { addStage, archiveStage, updateStage } from "../services/stages.ts";
import { addTask, completeTask, snoozeTask } from "../services/tasks.ts";
import { undoChange } from "../services/undo.ts";
import { toolResult } from "./format.ts";
import {
  contactRef,
  DEAL_STATUSES,
  dealRef,
  FIELD_ENTITIES,
  FIELD_TYPES,
  fieldValues,
  longText,
  orNull,
  RULE_TYPES,
  ruleRef,
  ruleSettings,
  shortText,
  when,
} from "./schemas.ts";
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
      name: "complete_task",
      title: "Complete a task",
      kind: "write",
      idempotent: true,
      description: "Marks a task done. Find the task id with whats_due or get_deal. Undo it with undo_change.",
      input: z.strictObject({ task: z.string().min(1).max(100).describe("The task's id, tk_...") }),
      async run({ task }, deps) {
        const result = await completeTask(aiCtx(deps, "complete_task"), task);
        return toolResult(result.summary, { changeId: result.changeId, taskId: result.taskId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "snooze_task",
      title: "Snooze a task",
      kind: "write",
      idempotent: true,
      description: "Hides an open task from whats_due until a later time, when it comes back.",
      input: z.strictObject({
        task: z.string().min(1).max(100).describe("The task's id, tk_..."),
        until: when("When the task should come back; it must be in the future"),
      }),
      async run({ task, until }, deps) {
        const result = await snoozeTask(aiCtx(deps, "snooze_task"), task, until);
        return toolResult(result.summary, { changeId: result.changeId, taskId: result.taskId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_stage",
      title: "Add a stage",
      kind: "write",
      description:
        "Adds a pipeline stage. Its key is made from the label (\"Demo booked\" becomes demo_booked). By default it goes " +
        "after the last open stage; say `after` to put it elsewhere.",
      input: z.strictObject({
        label: shortText("The stage's name, for example \"Demo booked\"."),
        kind: z.enum(["open", "won", "lost", "not_now"]).optional().describe("open (the default), or a closing kind."),
        after: shortText("The stage it goes after: its key or label.").optional(),
      }),
      async run(args, deps) {
        const result = await addStage(aiCtx(deps, "add_stage"), args);
        return toolResult(result.summary, { changeId: result.changeId, key: result.key });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_stage",
      title: "Rename or move a stage",
      kind: "write",
      idempotent: true,
      description:
        "Renames a stage (its key stays the same, so deals and rules keep working) and/or moves it to a position. " +
        "Positions count from 1 among the stages that are not archived.",
      input: z.strictObject({
        stage: shortText("The stage: its key (call_done) or label (Call done)."),
        label: shortText("The new name.").optional(),
        position: z.number().int().min(1).max(100).optional().describe("The new place, counting from 1."),
      }),
      async run({ stage, ...patch }, deps) {
        const result = await updateStage(aiCtx(deps, "update_stage"), stage, patch);
        return toolResult(result.summary, { changeId: result.changeId, key: result.key });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "archive_stage",
      title: "Archive a stage",
      kind: "write",
      description:
        "Retires a stage: it leaves the board and the stage list. Refused while open deals sit in it (the answer says " +
        "which and where to move them) and for the last stage of a kind. Undo it with undo_change.",
      input: z.strictObject({ stage: shortText("The stage: its key or label.") }),
      async run({ stage }, deps) {
        const result = await archiveStage(aiCtx(deps, "archive_stage"), stage);
        return toolResult(result.summary, { changeId: result.changeId, key: result.key });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_field",
      title: "Add a custom field",
      kind: "write",
      description:
        "Adds a custom field to contacts or deals. Types: text, number, date (YYYY-MM-DD) or choice (give the choices). " +
        "Its key is made from the label; use the key when setting values.",
      input: z.strictObject({
        entity: z.enum(FIELD_ENTITIES).describe("Whether the field is on contacts or on deals."),
        label: shortText("The field's name, for example \"Budget\"."),
        type: z.enum(FIELD_TYPES).describe("text, number, date or choice."),
        choices: z.array(z.string().max(100)).max(50).optional().describe("The options of a choice field; only for choice."),
      }),
      async run(args, deps) {
        const result = await addField(aiCtx(deps, "add_field"), args);
        return toolResult(result.summary, { changeId: result.changeId, fieldId: result.fieldId, key: result.key });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_field",
      title: "Update a custom field",
      kind: "write",
      idempotent: true,
      description:
        "Renames a custom field (its key stays), adds choices to a choice field, or archives or restores it. A choice " +
        "that records use can't be removed. Values already stored stay on the records.",
      input: z.strictObject({
        field: shortText("The field: its id (fd_...), or its key or label (give `entity` if both kinds of record have it)."),
        entity: z.enum(FIELD_ENTITIES).optional().describe("Narrows a lookup by key or label."),
        label: shortText("The new name.").optional(),
        choices: z.array(z.string().max(100)).max(50).optional().describe("The whole list of choices, with the new ones added."),
        archived: z.boolean().optional().describe("true to archive the field, false to bring it back."),
      }),
      async run({ field, ...patch }, deps) {
        const result = await updateField(aiCtx(deps, "update_field"), field, patch);
        return toolResult(result.summary, { changeId: result.changeId, fieldId: result.fieldId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_rule",
      title: "Add a rule",
      kind: "write",
      description:
        "Adds a rule the hourly run follows. stage_followup: when a deal has sat in a stage for `days` days with no " +
        "contact logged, add a follow-up task. on_stage_enter: when a deal enters a stage, add a task (`title`, due " +
        "`dueInDays` after). gone_quiet: flag open deals with no contact for `days` days in the daily brief. Show the " +
        "owner preview_rule first. The description is written for you unless you give one.",
      input: z.strictObject({
        type: z.enum(RULE_TYPES).describe("stage_followup, on_stage_enter or gone_quiet."),
        ...ruleSettings,
        description: shortText("What the rule does, in plain English; written from the settings when left out.").optional(),
      }),
      async run(args, deps) {
        const result = await addRule(aiCtx(deps, "add_rule"), args);
        return toolResult(result.summary, { changeId: result.changeId, ruleId: result.ruleId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_rule",
      title: "Update a rule",
      kind: "write",
      idempotent: true,
      description:
        "Changes a rule's settings or description (its type stays). Give only what changes. When the settings change " +
        "and no description is given, the description is rewritten to match.",
      input: z.strictObject({
        rule: ruleRef(),
        ...ruleSettings,
        description: shortText("A new plain-English description.").optional(),
      }),
      async run({ rule, ...patch }, deps) {
        const result = await updateRule(aiCtx(deps, "update_rule"), rule, patch);
        return toolResult(result.summary, { changeId: result.changeId, ruleId: result.ruleId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "pause_rule",
      title: "Pause a rule",
      kind: "write",
      idempotent: true,
      description: "Stops a rule from firing (and a gone_quiet rule from flagging deals) until resume_rule. Rules are never deleted.",
      input: z.strictObject({ rule: ruleRef() }),
      async run({ rule }, deps) {
        const result = await pauseRule(aiCtx(deps, "pause_rule"), rule);
        return toolResult(result.summary, { changeId: result.changeId, ruleId: result.ruleId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "resume_rule",
      title: "Resume a rule",
      kind: "write",
      idempotent: true,
      description: "Turns a paused rule back on. It catches up on the next hourly run.",
      input: z.strictObject({ rule: ruleRef() }),
      async run({ rule }, deps) {
        const result = await resumeRule(aiCtx(deps, "resume_rule"), rule);
        return toolResult(result.summary, { changeId: result.changeId, ruleId: result.ruleId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_rulebook",
      title: "Update the rulebook",
      kind: "write",
      idempotent: true,
      description:
        "Creates or replaces one rulebook document (voice, pipeline, guardrails, or a new name). Send the whole new text: " +
        "read it first with get_rulebook and change only what the owner asked. Undo it with undo_change.",
      input: z.strictObject({
        name: z.string().min(1).max(40).describe("The document's name: letters, numbers, \"-\" and \"_\"."),
        markdown: z.string().min(1).max(20_000).describe("The document's whole text, in markdown."),
      }),
      async run({ name, markdown }, deps) {
        const result = await updateRulebook(aiCtx(deps, "update_rulebook"), name, markdown);
        return toolResult(result.summary, { changeId: result.changeId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_settings",
      title: "Update the settings",
      kind: "write",
      idempotent: true,
      description:
        "Changes the owner's timezone, the daily brief's hour, address or on/off switch. Give only what changes. Owner " +
        "emails can't be changed here.",
      input: z.strictObject({
        timezone: shortText("An IANA timezone name, for example America/Los_Angeles or Europe/London.").optional(),
        briefHour: z.number().int().min(0).max(23).optional().describe("The hour the daily brief goes out, 0 to 23 in the owner's timezone."),
        briefEmail: orNull(shortText("The address the brief is sent to, or null to clear it.")).optional(),
        briefEnabled: z.boolean().optional().describe("true to send the daily brief, false to stop."),
      }),
      async run(args, deps) {
        const result = await updateSettings(aiCtx(deps, "update_settings"), args);
        return toolResult(result.summary, { changeId: result.changeId });
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
