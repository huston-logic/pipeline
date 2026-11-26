// A proposal's actions (decision 0044): each is one record tool's input plus `action`, the tool's name. This file
// checks a list of them (the schema, the cap, the "@n" rules), resolves the records they name to ids (a name that
// matches several records, or none, becomes a question for the owner) and runs one action through its service.
import { z } from "zod";
import type { ContactRow, Db, DealRow, ProjectRow, TaskRow } from "../db/db.ts";
import { getContact } from "../db/queries.ts";
import { inputErrorMessage } from "./input-errors.ts";
import {
  addContactInput,
  addDealInput,
  addLeadInput,
  addProjectInput,
  addTaskInput,
  addTaskPlanInput,
  addRuleInput,
  addTemplateInput,
  completeTaskInput,
  pauseRuleInput,
  resumeRuleInput,
  updateRuleInput,
  saveProjectAsTemplateInput,
  updateTemplateInput,
  logActivityInput,
  qualifyLeadInput,
  returnToLeadInput,
  addTimeEntryInput,
  cancelTimerInput,
  snoozeTaskInput,
  startTimerInput,
  stopTimerInput,
  updateContactInput,
  updateDealInput,
  updateProjectInput,
  updateTimeEntryInput,
} from "./record-inputs.ts";
import { logActivity } from "./activities.ts";
import { addContact } from "./add-contact.ts";
import { addDeal } from "./add-deal.ts";
import type { ChangeResult, Ctx } from "./change.ts";
import { updateContact } from "./contacts.ts";
import { updateDeal } from "./deals.ts";
import { short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { contactRef, dealTitle, isTrusted, projectTitle, taskTitle } from "./labels.ts";
import { addLead, qualifyLead, returnToLead } from "./leads.ts";
import { type Match, MATCH_MAX, matchAll } from "./name-match.ts";
import { readerOf, type Reader } from "./memo.ts";
import { addProject, updateProject } from "./projects.ts";
import { addRule, pauseRule, resumeRule, updateRule } from "./rules.ts";
import { requireProjects } from "./settings.ts";
import { saveProjectAsTemplate } from "./save-template.ts";
import { addTaskPlan } from "./task-plan.ts";
import { addTemplate, updateTemplate } from "./templates.ts";
import { addTask, completeTask, snoozeTask } from "./tasks.ts";
import { addTimeEntry, updateTimeEntry } from "./time-entries.ts";
import { cancelTimer, startTimer, stopTimer } from "./timer.ts";

/** The record tools a proposal can hold, in the order the schema lists them; then four of time (decision 0049) and two of projects (0055). */
export const RECORD_ACTIONS = [
  "add_lead",
  "add_deal",
  "add_contact",
  "update_contact",
  "update_deal",
  "qualify_lead",
  "return_to_lead",
  "log_activity",
  "add_task",
  "complete_task",
  "snooze_task",
  "start_timer",
  "stop_timer",
  "cancel_timer",
  "add_time_entry",
  "update_time_entry",
  "add_project",
  "update_project",
  "add_task_plan",
  "add_template",
  "update_template",
  "save_project_as_template",
] as const;

export type RecordActionName = (typeof RECORD_ACTIONS)[number];

/**
 * The rule tools a proposal can hold (decision 0061). They are not record tools: while the owner approves in chat they
 * write at once, as before, and propose_changes refuses them. Only while the owner approves on the board only do they
 * wait there as proposal actions.
 */
export const RULE_ACTIONS = ["add_rule", "update_rule", "pause_rule", "resume_rule"] as const;

export type RuleActionName = (typeof RULE_ACTIONS)[number];

export const PROPOSAL_ACTIONS = [...RECORD_ACTIONS, ...RULE_ACTIONS] as const;

export type ProposalActionName = RecordActionName | RuleActionName;

/** The most rule actions one list holds: each reads its rule on its own, and a list stays within the D1 call budget. */
export const RULE_ACTIONS_MAX = 10;

export const isRuleAction = (action: { action: string }): action is { action: RuleActionName } =>
  (RULE_ACTIONS as readonly string[]).includes(action.action);

const named = <A extends ProposalActionName>(action: A) =>
  z.literal(action).describe(`The record tool this action is: ${action}, with that tool's inputs.`);

/** Each action's schema: the tool's input plus `action`. */
const ACTION_SCHEMAS = {
  add_lead: addLeadInput.extend({ action: named("add_lead") }),
  add_deal: addDealInput.extend({ action: named("add_deal") }),
  add_contact: addContactInput.extend({ action: named("add_contact") }),
  update_contact: updateContactInput.extend({ action: named("update_contact") }),
  update_deal: updateDealInput.extend({ action: named("update_deal") }),
  qualify_lead: qualifyLeadInput.extend({ action: named("qualify_lead") }),
  return_to_lead: returnToLeadInput.extend({ action: named("return_to_lead") }),
  log_activity: logActivityInput.extend({ action: named("log_activity") }),
  add_task: addTaskInput.extend({ action: named("add_task") }),
  complete_task: completeTaskInput.extend({ action: named("complete_task") }),
  snooze_task: snoozeTaskInput.extend({ action: named("snooze_task") }),
  start_timer: startTimerInput.extend({ action: named("start_timer") }),
  stop_timer: stopTimerInput.extend({ action: named("stop_timer") }),
  cancel_timer: cancelTimerInput.extend({ action: named("cancel_timer") }),
  add_time_entry: addTimeEntryInput.extend({ action: named("add_time_entry") }),
  update_time_entry: updateTimeEntryInput.extend({ action: named("update_time_entry") }),
  add_project: addProjectInput.extend({ action: named("add_project") }),
  update_project: updateProjectInput.extend({ action: named("update_project") }),
  add_task_plan: addTaskPlanInput.extend({ action: named("add_task_plan") }),
  add_template: addTemplateInput.extend({ action: named("add_template") }),
  update_template: updateTemplateInput.extend({ action: named("update_template") }),
  save_project_as_template: saveProjectAsTemplateInput.extend({ action: named("save_project_as_template") }),
  add_rule: addRuleInput.extend({ action: named("add_rule") }),
  update_rule: updateRuleInput.extend({ action: named("update_rule") }),
  pause_rule: pauseRuleInput.extend({ action: named("pause_rule") }),
  resume_rule: resumeRuleInput.extend({ action: named("resume_rule") }),
} as const satisfies Record<ProposalActionName, z.ZodObject>;

/** One action: a record tool's input plus `action`, the tool's name (a discriminated union on it). */
export const recordActionSchema = z.discriminatedUnion("action", [
  ACTION_SCHEMAS.add_lead,
  ACTION_SCHEMAS.add_deal,
  ACTION_SCHEMAS.add_contact,
  ACTION_SCHEMAS.update_contact,
  ACTION_SCHEMAS.update_deal,
  ACTION_SCHEMAS.qualify_lead,
  ACTION_SCHEMAS.return_to_lead,
  ACTION_SCHEMAS.log_activity,
  ACTION_SCHEMAS.add_task,
  ACTION_SCHEMAS.complete_task,
  ACTION_SCHEMAS.snooze_task,
  ACTION_SCHEMAS.start_timer,
  ACTION_SCHEMAS.stop_timer,
  ACTION_SCHEMAS.cancel_timer,
  ACTION_SCHEMAS.add_time_entry,
  ACTION_SCHEMAS.update_time_entry,
  ACTION_SCHEMAS.add_project,
  ACTION_SCHEMAS.update_project,
  ACTION_SCHEMAS.add_task_plan,
  ACTION_SCHEMAS.add_template,
  ACTION_SCHEMAS.update_template,
  ACTION_SCHEMAS.save_project_as_template,
  ACTION_SCHEMAS.add_rule,
  ACTION_SCHEMAS.update_rule,
  ACTION_SCHEMAS.pause_rule,
  ACTION_SCHEMAS.resume_rule,
]);

export type RecordAction = z.output<typeof recordActionSchema>;

/** An action whose records are named by id, or by "@n" for the record action n adds (as the subject only). */
export type ResolvedAction = RecordAction;

type RefKind = "contact" | "deal" | "task" | "project";

type RefSpec = { field: RefKind; kind: RefKind; subject: boolean };

const TIME_SUBJECT: RefSpec[] = [
  { field: "deal", kind: "deal", subject: true },
  { field: "contact", kind: "contact", subject: true },
  { field: "task", kind: "task", subject: true },
  { field: "project", kind: "project", subject: true },
];

/** The fields of each action that name a record, and whether "@n" may fill them (the action's subject). */
const REF_FIELDS: Record<ProposalActionName, RefSpec[]> = {
  add_lead: [],
  add_deal: [{ field: "contact", kind: "contact", subject: false }],
  add_contact: [],
  update_contact: [{ field: "contact", kind: "contact", subject: false }],
  update_deal: [{ field: "deal", kind: "deal", subject: false }],
  qualify_lead: [{ field: "contact", kind: "contact", subject: false }],
  return_to_lead: [{ field: "deal", kind: "deal", subject: false }],
  log_activity: [
    { field: "deal", kind: "deal", subject: true },
    { field: "contact", kind: "contact", subject: true },
    { field: "project", kind: "project", subject: true },
  ],
  add_task: [
    { field: "deal", kind: "deal", subject: true },
    { field: "contact", kind: "contact", subject: true },
    { field: "project", kind: "project", subject: true },
  ],
  complete_task: [{ field: "task", kind: "task", subject: false }],
  snooze_task: [{ field: "task", kind: "task", subject: false }],
  // What the time is for may be a person, deal or task an earlier action adds.
  start_timer: TIME_SUBJECT,
  stop_timer: [],
  cancel_timer: [],
  add_time_entry: TIME_SUBJECT,
  update_time_entry: [
    { field: "deal", kind: "deal", subject: false },
    { field: "contact", kind: "contact", subject: false },
    { field: "task", kind: "task", subject: false },
    { field: "project", kind: "project", subject: false },
  ],
  // A project may be for a person an earlier action adds; its deal must already be won, so it is never "@n".
  add_project: [
    { field: "contact", kind: "contact", subject: true },
    { field: "deal", kind: "deal", subject: false },
  ],
  update_project: [{ field: "project", kind: "project", subject: false }],
  // A plan may be for a project an earlier action adds.
  add_task_plan: [{ field: "project", kind: "project", subject: true }],
  add_template: [],
  update_template: [],
  // A project an earlier action adds (with its tasks) may be saved.
  save_project_as_template: [{ field: "project", kind: "project", subject: true }],
  // A rule is named by its id; no rule is an "@n" (a list never updates a rule it adds).
  add_rule: [],
  update_rule: [],
  pause_rule: [],
  resume_rule: [],
};

/** What an action adds (or, for qualify_lead's person, names) that a later "@n" could point at. */
const ADDS: Partial<Record<ProposalActionName, readonly RefKind[]>> = {
  add_lead: ["contact"],
  add_contact: ["contact"],
  add_deal: ["contact", "deal"],
  qualify_lead: ["contact", "deal"],
  add_task: ["task"],
  add_project: ["project"],
};

const NOUNS: Record<RefKind, string> = { contact: "person", deal: "deal", task: "task", project: "project" };

const REF = /^@(\d+)$/;

function refsOf(action: RecordAction): (RefSpec & { value: string })[] {
  const values = action as Partial<Record<RefKind, unknown>>;
  return REF_FIELDS[action.action].flatMap((ref) => {
    const value = values[ref.field];
    return typeof value === "string" ? [{ ...ref, value }] : [];
  });
}

/** The action number an "@n" names, or null for a name or an id. */
const refNumber = (value: string): number | null => {
  const match = REF.exec(value.trim());
  return match ? Number(match[1]) : null;
};

/**
 * Checks each action against its tool's schema and the "@n" rules: "@n" names a person or deal an earlier action adds,
 * and only as the subject of log_activity or add_task, or (with a task, too) of start_timer or add_time_entry. Answers
 * the actions as parsed.
 */
export function checkActions(actions: readonly unknown[]): RecordAction[] {
  return actions.map((raw, i) => {
    const n = i + 1;
    const parsed = recordActionSchema.safeParse(raw);
    if (!parsed.success) {
      const name = (raw as { action?: unknown } | null)?.action;
      const known = PROPOSAL_ACTIONS.find((action) => action === name);
      if (known === undefined) throw new UserError(`Action ${n} needs "action": one of ${RECORD_ACTIONS.join(", ")}.`);
      throw new UserError(`Action ${n}: ${inputErrorMessage(known, ACTION_SCHEMAS[known], parsed.error.issues, raw)}`);
    }
    const action = parsed.data;
    for (const ref of refsOf(action)) {
      const target = refNumber(ref.value);
      if (target === null) {
        if (ref.value.trim().startsWith("@")) {
          throw new UserError(`Action ${n}'s ${ref.field} "${short(ref.value, 20)}" isn't an action number. Use @ and the number of an earlier action, for example @1.`);
        }
        continue;
      }
      if (target < 1 || target >= n) {
        const which = n > 1 ? ` (@1 to @${n - 1})` : "";
        throw new UserError(`Action ${n} names @${target}, but only an earlier action can be named${which}.`);
      }
      const earlier = (actions[target - 1] as { action?: ProposalActionName }).action;
      const adds = (earlier === undefined ? undefined : ADDS[earlier]) ?? [];
      if (!adds.includes(ref.kind)) {
        if (ref.kind === "deal" && adds.includes("contact")) {
          throw new UserError(`Action ${n} names @${target} as its deal, but action ${target} adds a person, not a deal. Give @${target} as the contact instead.`);
        }
        const what = ref.kind !== "project" && ref.subject && !adds.includes("contact") && !adds.includes("deal") ? "person or deal" : NOUNS[ref.kind];
        throw new UserError(`Action ${n} names @${target}, but action ${target} adds no ${what}.`);
      }
      if (!ref.subject) {
        throw new UserError(`Action ${n} changes the ${NOUNS[ref.kind]} action ${target} adds. Put those details in action ${target} instead.`);
      }
    }
    return action;
  });
}

/** "a", "a or b", "a, b or c". */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

const AGAIN = "Send the list again with the id.";

const tooMany = (shown: string, noun: string) => ({ question: `"${shown}" matches more than ${MATCH_MAX} ${noun}. Use more of the name, or the id.` });

type Found = { id: string } | { question: string };

function contactQuestion(match: Match<ContactRow>, ref: string): Found {
  const shown = short(ref, 60);
  if (match.kind === "one") return { id: match.row.id };
  if (match.kind === "tooMany") return tooMany(shown, match.noun);
  if (match.kind === "none") return { question: `Who is "${shown}"? No one on file matches. Send the list again with their id, or add them first.` };
  return { question: `Which ${shown}? ${joinOr(match.rows.map(contactRef))}. ${AGAIN}` };
}

async function dealQuestion(db: Db, match: Match<DealRow>, ref: string): Promise<Found> {
  const shown = short(ref, 60);
  if (match.kind === "one") return { id: match.row.id };
  if (match.kind === "tooMany") return tooMany(shown, match.noun);
  if (match.kind === "none") return { question: `Which deal is "${shown}"? No open deal matches. Send the list again with the deal's id.` };
  const people = new Map<string, ContactRow | null>();
  for (const deal of match.rows) if (!people.has(deal.contact_id)) people.set(deal.contact_id, await getContact(db, deal.contact_id));
  const labels = match.rows.map((deal) => {
    const person = people.get(deal.contact_id);
    const who = person ? contactRef(person) : `contact ${deal.contact_id}`;
    return isTrusted(deal, "title") ? `${dealTitle(deal)} (${deal.id}) for ${who}` : `${dealTitle(deal)} for ${who}`;
  });
  return { question: `Which deal for ${shown}? ${joinOr(labels)}. ${AGAIN}` };
}

function taskQuestion(match: Match<TaskRow>, ref: string): Found {
  const shown = short(ref, 60);
  if (match.kind === "one") return { id: match.row.id };
  if (match.kind === "tooMany") return tooMany(shown, match.noun);
  if (match.kind === "none") return { question: `Which task is "${shown}"? No open task matches. Send the list again with the task's id.` };
  const labels = match.rows.map((task) => (isTrusted(task, "title") ? `${taskTitle(task)} (${task.id})` : taskTitle(task)));
  return { question: `Which task is "${shown}"? ${joinOr(labels)}. ${AGAIN}` };
}

function projectQuestion(match: Match<ProjectRow>, ref: string): Found {
  const shown = short(ref, 60);
  if (match.kind === "one") return { id: match.row.id };
  if (match.kind === "tooMany") return tooMany(shown, match.noun);
  if (match.kind === "none") return { question: `Which project is "${shown}"? No live project matches. Send the list again with the project's id.` };
  const labels = match.rows.map((project) => (isTrusted(project, "name") ? `${projectTitle(project)} (${project.id})` : projectTitle(project)));
  return { question: `Which project is "${shown}"? ${joinOr(labels)}. ${AGAIN}` };
}

/**
 * Every record the actions name, as an id ("@n" stays as it is). A name that matches several records, or none, is a
 * question; with any question, the caller stores nothing and answers every question at once. Every ref is read in one
 * D1 batch (matchAll).
 */
export async function resolveActions(src: Reader, actions: readonly RecordAction[]): Promise<{ actions: ResolvedAction[]; questions: string[] }> {
  const { db } = readerOf(src);
  // Every project input refuses while projects are off, before any name is matched (the memo makes this read free).
  const projectful = actions.some((action) => action.action === "add_project" || action.action === "update_project" || action.action === "add_template" || action.action === "update_template" || action.action === "save_project_as_template" || refsOf(action).some((ref) => ref.kind === "project"));
  if (projectful) await requireProjects(src);
  const named = actions.map((action) => refsOf(action).filter((ref) => refNumber(ref.value) === null));
  const asked: Record<RefKind, string[]> = { contact: [], deal: [], task: [], project: [] };
  for (const ref of named.flat()) if (!asked[ref.kind].includes(ref.value)) asked[ref.kind].push(ref.value);
  const matches = await matchAll(db, { contacts: asked.contact, deals: asked.deal, tasks: asked.task, projects: asked.project });
  const answer = async (kind: RefKind, value: string): Promise<Found> => {
    const i = asked[kind].indexOf(value);
    if (kind === "contact") return contactQuestion(matches.contacts[i] ?? { kind: "none" }, value);
    if (kind === "deal") return dealQuestion(db, matches.deals[i] ?? { kind: "none" }, value);
    if (kind === "project") return projectQuestion(matches.projects[i] ?? { kind: "none" }, value);
    return taskQuestion(matches.tasks[i] ?? { kind: "none" }, value);
  };
  const questions: string[] = [];
  const resolved: ResolvedAction[] = [];
  for (const [n, action] of actions.entries()) {
    const copy: Record<string, unknown> = { ...action };
    for (const ref of named[n] ?? []) {
      const found = await answer(ref.kind, ref.value);
      if ("id" in found) copy[ref.field] = found.id;
      else if (!questions.includes(found.question)) questions.push(found.question);
    }
    resolved.push(copy as ResolvedAction);
  }
  return { actions: resolved, questions };
}

export type ActionResult = ChangeResult & {
  contactId?: string;
  dealId?: string | null;
  activityId?: string;
  taskId?: string;
  entryId?: string;
  projectId?: string;
  ruleId?: string;
  matchedExisting?: boolean;
};

/** The action with each "@n" replaced by the id of the person, deal, task or project action n added (`added[n - 1]`). */
export function bindAction(action: ResolvedAction, added: readonly ActionResult[]): RecordAction {
  const copy: Record<string, unknown> = { ...action };
  for (const ref of refsOf(action)) {
    const target = refNumber(ref.value);
    if (target === null) continue;
    const result = added[target - 1];
    const id =
      ref.kind === "deal" ? result?.dealId : ref.kind === "task" ? result?.taskId : ref.kind === "project" ? result?.projectId : result?.contactId;
    if (typeof id !== "string") throw new UserError(`Action ${target} adds no ${NOUNS[ref.kind]}, so @${target} can't be used as the ${ref.field} here.`);
    copy[ref.field] = id;
  }
  return copy as RecordAction;
}

type ActionOf<A extends ProposalActionName> = Extract<RecordAction, { action: A }>;

function omitAction<A extends ProposalActionName>(action: ActionOf<A>): Omit<ActionOf<A>, "action"> {
  const copy: Partial<ActionOf<A>> = { ...action };
  delete copy.action;
  return copy as Omit<ActionOf<A>, "action">;
}

/** Runs one resolved action through its service with ctx (which may carry a plan). */
export async function runAction(ctx: Ctx, action: ResolvedAction, _deps: { extraOwnerEmails: string[] }): Promise<ActionResult> {
  switch (action.action) {
    case "add_lead": {
      const { contactFields, ...rest } = omitAction(action);
      return addLead(ctx, { ...rest, fields: contactFields });
    }
    case "add_deal":
      return addDeal(ctx, omitAction(action));
    case "add_contact":
      return addContact(ctx, omitAction(action));
    case "update_contact": {
      const { contact, ...patch } = omitAction(action);
      return updateContact(ctx, contact, patch);
    }
    case "update_deal": {
      const { deal, ...patch } = omitAction(action);
      return updateDeal(ctx, deal, patch);
    }
    case "qualify_lead":
      return qualifyLead(ctx, omitAction(action));
    case "return_to_lead":
      return returnToLead(ctx, omitAction(action));
    case "log_activity": {
      const { deal, contact, ...rest } = omitAction(action);
      return logActivity(ctx, { dealId: deal, contactId: contact, ...rest });
    }
    case "add_task": {
      const { deal, contact, ...rest } = omitAction(action);
      return addTask(ctx, { dealId: deal, contactId: contact, ...rest });
    }
    case "complete_task":
      return completeTask(ctx, action.task, { subTasks: action.subTasks });
    case "snooze_task":
      return snoozeTask(ctx, action.task, action.until);
    case "start_timer":
      return startTimer(ctx, omitAction(action));
    case "stop_timer": {
      const { activityId, taskId, ...rest } = await stopTimer(ctx, omitAction(action));
      return { ...rest, ...(activityId === null ? {} : { activityId }), ...(taskId === null ? {} : { taskId }) };
    }
    case "cancel_timer":
      return cancelTimer(ctx);
    case "add_time_entry":
      return addTimeEntry(ctx, omitAction(action));
    case "update_time_entry": {
      const { entry, ...patch } = omitAction(action);
      return updateTimeEntry(ctx, entry, patch);
    }
    case "add_project":
      return addProject(ctx, omitAction(action));
    case "update_project": {
      const { project, ...patch } = omitAction(action);
      return updateProject(ctx, project, patch);
    }
    case "add_task_plan": {
      const { taskIds, ...result } = await addTaskPlan(ctx, omitAction(action));
      return { ...result, taskId: taskIds[0] ?? "" };
    }
    case "add_template":
      return addTemplate(ctx, omitAction(action));
    case "update_template": {
      const { template, ...patch } = omitAction(action);
      return updateTemplate(ctx, template, patch);
    }
    case "save_project_as_template":
      return saveProjectAsTemplate(ctx, omitAction(action));
    case "add_rule":
      return addRule(ctx, omitAction(action));
    case "update_rule": {
      const { rule, ...patch } = omitAction(action);
      return updateRule(ctx, rule, patch);
    }
    case "pause_rule":
      return pauseRule(ctx, action.rule);
    case "resume_rule":
      return resumeRule(ctx, action.rule);
  }
}

/**
 * The actions as a proposal keeps them: a stop with no end gets the time it was asked for (`now`), so a yes that comes
 * later stores the same span the owner was shown (decision 0049).
 */
export function withStopTimes(actions: readonly ResolvedAction[], now: Date): ResolvedAction[] {
  return actions.map((action) => (action.action === "stop_timer" && action.endedAt === undefined ? { ...action, endedAt: now.toISOString() } : action));
}
