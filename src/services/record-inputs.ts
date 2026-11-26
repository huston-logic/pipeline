// The record write tools' inputs (add_lead, add_deal, add_contact, update_contact, update_deal, qualify_lead,
// return_to_lead, log_activity, add_task, complete_task, snooze_task, and the time ones of decision 0049: start_timer,
// stop_timer, add_time_entry, update_time_entry, and decision 0055's add_project, update_project). src/mcp/tools-write.ts registers each tool
// with its schema, and a proposal's action is the same object plus `action` (proposal-actions.ts, decision 0044).
import { z } from "zod";
import { CONTACT_TYPES } from "./activities.ts";
import {
  contactRef,
  DEAL_STATUSES,
  dealRef,
  fieldValues,
  longText,
  orNull,
  shortText,
  statusRef,
  subStatusRef,
  when,
} from "./input-schemas.ts";
import { LEAD_STATUSES } from "./lead-status.ts";

/** Owner-loggable activity types: the contact types without "form", which only comes in through /intake. */
export const LOGGABLE = CONTACT_TYPES.filter((type) => type !== "form") as ["email", "call", "meeting", "note"];

const projectRef = (what = "") =>
  z.string().min(1).max(200).describe(`The project: its id (pj_...) or exact name. Its person is the record's person; leave out deal.${what}`);

const projectStatusInput = (what: string) => shortText(`${what}: its key or label (active, on_hold or done by default; see list_projects).`);

export const addProjectInput = z.strictObject({
  name: shortText("The project's name, on one line. The default is the deal's title when it is the owner's own.").optional(),
  contact: contactRef("The project's person: their id (ct_...) or exact name. Leave out contact and deal for an internal project.").optional(),
  deal: dealRef("The won deal it comes from: its id (dl_...) or exact title. Its person is the project's person.").optional(),
  status: projectStatusInput("The status. The default is active").optional(),
  startAt: when("When the project starts").optional(),
  targetAt: when("When it should be done").optional(),
  notes: longText("Notes about the project.").optional(),
  fields: fieldValues("project").optional(),
  moveOpenTasks: z
    .boolean()
    .optional()
    .describe("With deal: true also moves the deal's open tasks onto the project. The default is false."),
  completeOpenTasks: z
    .boolean()
    .optional()
    .describe("With deal: true marks the deal's open tasks done; they stay on the deal. Wins over moveOpenTasks. The default is false."),
  template: shortText(
    "A project template to copy: its id (tp_...) or exact name (see list_templates). Its tasks are copied as they are now; a template with due days and no startAt makes the project start today.",
  ).optional(),
});

export const updateProjectInput = z.strictObject({
  project: z.string().min(1).max(200).describe("The project: its id (pj_...) or exact name."),
  name: shortText("The new name, on one line.").optional(),
  status: projectStatusInput("The new status").optional(),
  startAt: orNull(when("The new start, or null to clear it")).optional(),
  targetAt: orNull(when("The new target, or null to clear it")).optional(),
  notes: orNull(longText("The project's notes, or null to clear them.")).optional(),
  fields: fieldValues("project").optional(),
  archived: z.boolean().optional().describe("true to archive the project, false to bring it back."),
});

const taskRef = () => z.string().min(1).max(100).describe("The task's id, tk_...");

export const addLeadInput = z.strictObject({
  name: shortText("The person's name. Needed unless business is given.").optional(),
  business: shortText("Their business name.").optional(),
  email: shortText("Their email address. One already on file is refused.").optional(),
  phone: shortText("Their phone number.").optional(),
  source: shortText("Where the lead came from, for example \"referral\" or \"drove past\".").optional(),
  notes: longText("Anything worth remembering, in a few words; logged as a note on the person.").optional(),
  contactFields: fieldValues("contact").optional(),
  allowDuplicate: z.boolean().optional().describe("true to add the lead even though someone on file has the same business."),
});

export const addDealInput = z.strictObject({
  name: shortText("The person's name. Needed unless contact is given.").optional(),
  contact: contactRef(
    "An existing contact to add the deal to: their id (ct_...) or exact name. Their details are left as they are.",
  ).optional(),
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
});

export const addContactInput = z.strictObject({
  name: shortText("The person's name."),
  email: shortText("Their email address. One already on file is refused.").optional(),
  phone: shortText("Their phone number.").optional(),
  business: shortText("Their business name.").optional(),
  source: shortText("Where they came from, for example \"referral\".").optional(),
  notes: longText("Notes about the person.").optional(),
  personStatus: statusRef("Their person status: its key or label (see list_person_statuses). The default is contact.").optional(),
  subStatus: orNull(
    subStatusRef("One of that status's sub-statuses: its key or label, or null for none (the default; a lead starts New)."),
  ).optional(),
  fields: fieldValues("contact").optional(),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe("With a lead: true to add them even though someone on file has the same business, as add_lead."),
});

export const qualifyLeadInput = z.strictObject({
  contact: contactRef("The lead: their id (ct_...) or exact name."),
  createDeal: z.boolean().optional().describe("false to only set Qualified, with no deal. The default is true."),
  stage: shortText("An open stage for the deal: its key (call_booked) or label (Call booked). The default is the first.").optional(),
  dealTitle: shortText("The deal's title; the default is \"<name> inquiry\".").optional(),
  value: z.number().min(0).optional().describe("The deal's value, a number of 0 or more."),
  nextStep: shortText("The next step, for example \"Send a quote\".").optional(),
  nextAt: when("When the next step is due").optional(),
});

export const returnToLeadInput = z.strictObject({
  deal: dealRef(),
  status: z
    .enum(LEAD_STATUSES)
    .optional()
    .describe("The person's lead status: new, contacted (the default), not_now, not_a_fit or bad. qualified is refused."),
});

export const updateContactInput = z.strictObject({
  contact: contactRef(),
  name: shortText("The new name.").optional(),
  email: orNull(shortText("The new email address, or null to clear it.")).optional(),
  phone: orNull(shortText("The new phone number, or null to clear it.")).optional(),
  business: orNull(shortText("The new business name, or null to clear it.")).optional(),
  source: orNull(shortText("Where the lead came from, or null to clear it.")).optional(),
  notes: orNull(longText("Notes about the person, or null to clear them.")).optional(),
  fields: fieldValues("contact").optional(),
  leadStatus: z
    .enum(LEAD_STATUSES)
    .optional()
    .describe(
      "The lead status: new, contacted, not_now, not_a_fit (a real business, wrong for us) or bad (wrong details, " +
        "closed, duplicate or spam). qualified is refused: use qualify_lead.",
    ),
  followUpDate: when(
    "With leadStatus not_now (or for a lead already Not now): when to check back, which adds the task " +
      "\"Check back with <name>\" due then",
  ).optional(),
  personStatus: statusRef("A new person status: its key or label (see list_person_statuses). Not together with leadStatus.").optional(),
  subStatus: orNull(
    subStatusRef(
      "One of the person status's sub-statuses (the new one, or the current one): its key or label. null clears it " +
        "(not for a lead). Left out, it is kept when the status stays, New for a new lead, none otherwise.",
    ),
  ).optional(),
});

export const updateDealInput = z.strictObject({
  deal: dealRef(),
  stage: shortText("The stage to move to: its key (call_booked) or label (Call booked).").optional(),
  status: z.enum(DEAL_STATUSES).optional().describe("The new status. Ask the owner before won, lost or not_now."),
  title: shortText("The new title.").optional(),
  value: z.number().min(0).nullable().optional().describe("The deal's value, a number of 0 or more, or null to clear it."),
  nextStep: orNull(shortText("The next step, or null to clear it.")).optional(),
  nextAt: orNull(when("When the next step is due, or null to clear it")).optional(),
  fields: fieldValues("deal").optional(),
});

export const logActivityInput = z.strictObject({
  deal: dealRef().optional(),
  contact: contactRef().optional(),
  project: projectRef().optional(),
  type: z.enum(LOGGABLE).describe("What kind of contact it was."),
  summary: longText("What happened, in a sentence or two."),
  occurredAt: when("When it happened; the default is now. It can't be in the future").optional(),
});

export const addTaskInput = z.strictObject({
  deal: dealRef("The deal: its id (dl_...), its exact title, or its contact's exact name. Leave out deal and contact for a task of the owner's own.").optional(),
  contact: contactRef("The contact: their id (ct_...) or exact name. Leave out deal and contact for a task of the owner's own.").optional(),
  project: projectRef().optional(),
  parent: z.string().min(1).max(100).describe("A sub-task: the id (tk_...) of an open task on a project to put this under. The project and person are the parent's.").optional(),
  title: shortText("What to do, in a few words."),
  description: longText("Steps and detail, at most 10,000 characters. Keep the title short and put the detail here.").optional(),
  dueAt: when("When it is due").optional(),
});

export const taskPlanItemInput = z.strictObject({
  title: shortText("What to do, in a few words."),
  description: longText("Steps and detail, at most 10,000 characters. Keep the title short and put the detail here.").optional(),
  due: when("When it is due").optional(),
  dueDays: z.number().int().min(0).max(3650).describe("Days after the project's start date; use this or due.").optional(),
  under: z.number().int().describe("The 1-based number of an earlier task in this list to put this under.").optional(),
  workType: shortText("The work type for time on this task: its name or id (see list_work_types). Needs time tracking on.").optional(),
});

export const templateTaskInput = z.strictObject({
  title: shortText("What to do, in a few words."),
  description: longText("Steps and detail, at most 10,000 characters. Keep the title short and put the detail here.").optional(),
  dueDays: z.number().int().min(0).max(3650).describe("Days after the project's start date.").optional(),
  workType: shortText("The work type: its name or id (see list_work_types). Needs time tracking on.").optional(),
  under: z.number().int().describe("The 1-based number of an earlier task in this list to put this under.").optional(),
});

const templateRef = () => z.string().min(1).max(200).describe("The template: its id (tp_...) or exact name (see list_templates).");

export const addTemplateInput = z.strictObject({
  name: shortText("The template's name, on one line."),
  description: longText("What the template is for.").optional(),
  tasks: z.array(templateTaskInput).min(1).max(100).describe("The tasks, in order, at most 100."),
});

export const updateTemplateInput = z.strictObject({
  template: templateRef(),
  name: shortText("The new name, on one line.").optional(),
  description: orNull(longText("The new description, or null to clear it.")).optional(),
  archived: z.boolean().optional().describe("true to archive the template, false to bring it back."),
  tasks: z.array(templateTaskInput).min(1).max(100).describe("Replaces the whole task list: every live task is archived and these are added.").optional(),
});

export const saveProjectAsTemplateInput = z.strictObject({
  project: projectRef().describe("The project to copy: its id (pj_...) or exact name."),
  name: shortText("The new template's name, on one line."),
  description: longText("What the template is for.").optional(),
});

export const addTaskPlanInput = z.strictObject({
  project: projectRef("").describe("The project: its id (pj_...) or exact name, or @n for a project an earlier action in the list adds."),
  under: z.string().min(1).max(100).describe("An open task (tk_...) of the project to put the whole plan under.").optional(),
  tasks: z.array(taskPlanItemInput).min(1).max(100).describe("The tasks, in order, at most 100."),
});

export const completeTaskInput = z.strictObject({
  task: taskRef(),
  subTasks: z.enum(["complete", "leave"]).optional().describe('Needed when the task has open sub-tasks: "complete" finishes them too, "leave" keeps them open.'),
});

export const snoozeTaskInput = z.strictObject({
  task: taskRef(),
  until: when("When the task should come back; it must be in the future"),
});

const timeContact = (what = "") =>
  contactRef(`The person the time is for: their id (ct_...) or exact name.${what}`);
const timeDeal = (what = "") =>
  dealRef(`The deal the time is for: its id (dl_...), its exact title, or its contact's exact name. Its person is the entry's person.${what}`);
const timeTask = (what = "") =>
  z.string().min(1).max(100).describe(`The task the time is for: its id, tk_... (see list_tasks). Its deal and person are used when you give neither.${what}`);
const workTypeRef = (what = "") => shortText(`The work type: its name or id (see list_work_types).${what}`);
const billableFlag = () =>
  z.boolean().describe("Whether the time is billed. The default is the work type's (not billable with no work type).");
const minutesInput = () => z.number().int().min(1).max(960).describe("How long it took, 1 to 960 minutes (16 hours). Give this or endedAt.");

export const startTimerInput = z.strictObject({
  contact: timeContact().optional(),
  deal: timeDeal().optional(),
  task: timeTask().optional(),
  project: projectRef().optional(),
  workType: workTypeRef().optional(),
});

export const stopTimerInput = z.strictObject({
  notes: longText("What was done, in the owner's words; kept on the entry and logged as a note on its person or deal.").optional(),
  workType: workTypeRef(" Changes the timer's.").optional(),
  billable: billableFlag().optional(),
  nextStepDate: when("Adds the task \"Next step\" due then, on the timer's person or deal").optional(),
  startedAt: when("The real start, when the timer was started late or left running").optional(),
  endedAt: when("The real end, when the timer was left running; the default is now").optional(),
});

export const addTimeEntryInput = z.strictObject({
  contact: timeContact().optional(),
  deal: timeDeal().optional(),
  task: timeTask().optional(),
  project: projectRef().optional(),
  startedAt: when("When the work started"),
  endedAt: when("When it ended; give this or minutes").optional(),
  minutes: minutesInput().optional(),
  workType: workTypeRef().optional(),
  billable: billableFlag().optional(),
  notes: longText("What was done, in a few words.").optional(),
});

export const updateTimeEntryInput = z.strictObject({
  entry: z.string().min(1).max(100).describe("The entry's id, te_... (see list_time)."),
  contact: orNull(timeContact(" null clears it.")).optional(),
  deal: orNull(timeDeal(" null clears it.")).optional(),
  task: orNull(timeTask(" null clears it.")).optional(),
  project: orNull(projectRef(" null clears it and keeps the person.")).optional(),
  startedAt: when("The new start; the end stays").optional(),
  endedAt: when("The new end; give this or minutes").optional(),
  minutes: minutesInput().optional(),
  workType: orNull(workTypeRef(" null clears it.")).optional(),
  billable: billableFlag().optional(),
  notes: orNull(longText("The entry's notes, or null to clear them.")).optional(),
  archived: z.boolean().optional().describe("true to archive the entry (it stops counting), false to bring it back."),
});

// The rule tools' inputs (decision 0061). A rule tool writes at once while the owner approves in chat; while they approve
// on the board only, the same input is a proposal action (proposal-actions.ts), so these live beside the record inputs.
export const RULE_TYPES = ["stage_followup", "on_stage_enter", "gone_quiet", "lead_followup"] as const;

export const ruleRef = () => z.string().min(1).max(100).describe("The rule's id, ru_... (see list_rules).");

/** A rule's settings. Which ones a type takes is checked by the rules service, which names the fix. */
export const ruleSettings = {
  stage: shortText("stage_followup and on_stage_enter: the open stage to watch, its key (proposal_sent) or label (Proposal sent).").optional(),
  status: z
    .enum(["new", "contacted"])
    .optional()
    .describe("lead_followup: the lead status to watch, new or contacted."),
  days: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe(
      "stage_followup: days in the stage with no contact logged (1-365); gone_quiet: days with no contact (1-365); " +
        "lead_followup: days in the status with no contact logged (1-365).",
    ),
  title: shortText(
    "The task title. on_stage_enter needs one; stage_followup's default is \"Follow up with {contact} about {deal}\", " +
      "lead_followup's is \"Follow up with {contact}\". It may use {deal}, {contact} and {stage} ({contact} only for " +
      "lead_followup).",
  ).optional(),
  dueInDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe("on_stage_enter: the task is due this many days after the deal enters the stage (0-365)."),
};

export const addRuleInput = z.strictObject({
  type: z.enum(RULE_TYPES).describe("stage_followup, on_stage_enter, gone_quiet or lead_followup."),
  ...ruleSettings,
  description: shortText("What the rule does, in plain English; written from the settings when left out.").optional(),
});

export const updateRuleInput = z.strictObject({
  rule: ruleRef(),
  ...ruleSettings,
  title: orNull(
    shortText(
      "The new task title, or null to go back to the default (stage_followup: \"Follow up with {contact} about " +
        "{deal}\"; lead_followup: \"Follow up with {contact}\"). It may use {deal}, {contact} and {stage} " +
        "({contact} only for lead_followup).",
    ),
  ).optional(),
  description: shortText("A new plain-English description.").optional(),
});

export const pauseRuleInput = z.strictObject({ rule: ruleRef() });
export const resumeRuleInput = z.strictObject({ rule: ruleRef() });
