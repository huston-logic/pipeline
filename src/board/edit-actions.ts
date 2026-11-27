// The board's editing posts (decision 0018): Add a deal for a new person, a new deal for a contact, Add contact
// (decision 0041), Edit contact, Edit deal, Add a task, Today's quick add (decision 0047), Done, Snooze and Log. Each calls the service the matching MCP
// tool calls, as the owner under that tool's name, and answers 303 back with ?change=. A refused post draws its form
// again (422) with the values kept and the errors. The lead routes (decision 0028) are in lead-actions.ts.
import type { ActivityType, FieldDefRow } from "../db/db.ts";
import { getContact, getDeal, getSettings, getTask, listFieldDefs } from "../db/queries.ts";
import { isContactId, isDealId, isProjectId, isTaskId } from "../ids.ts";
import { logActivity } from "../services/activities.ts";
import { addContact, type NewContactInput } from "../services/add-contact.ts";
import { addDeal, type DealInput } from "../services/add-deal.ts";
import { type ContactPatch, updateContact } from "../services/contacts.ts";
import { type DealPatch, updateDeal } from "../services/deals.ts";
import { DuplicateLeadError } from "../services/leads.ts";
import { ownerTimezone, projectById } from "../services/lookup.ts";
import { CONTACT } from "../services/person-move.ts";
import { listPersonStatuses } from "../services/person-status.ts";
import { addTask, completeTask, snoozeTask, updateTask } from "../services/tasks.ts";
import {
  type ActionContext,
  type ActionResult,
  asOwner,
  type Route,
  backTo,
  fieldError,
  notFound,
  page,
  pageContext,
  redirect,
  redirectBack,
  refusal,
  refusedFormPage,
  refusedPage,
  stateOf,
} from "./action-kit.ts";
import { descendants } from "../services/subtasks.ts";
import { type FormContext, hidden, postForm, RETURN_FIELD } from "./forms.ts";
import { renderPage } from "./layout.ts";
import { html } from "./html.ts";
import { errorSummary } from "./inputs.ts";
import { addReturn } from "./lead-forms.ts";
import { logForm, logSpecs } from "./log-form.ts";
import { contactEditPage, contactEditPath, contactEditSpecs } from "./pages/contact-edit.ts";
import { CONTACT_PATH, contactNewPage, newContactSpecs } from "./pages/contact-new.ts";
import { checkSubStatus, personRow } from "./person-status-form.ts";
import { dealEditPage, dealEditPath } from "./pages/deal-edit.ts";
import { newDealPage, newDealPath, newDealSpecs } from "./pages/deal-new.ts";
import { PERSON_DEAL_PATH, personDealPage } from "./pages/deal-new-person.ts";
import { contactHref, count, dealHref } from "./parts.ts";
import { collectEdit, collectNew, dealSpecs, line, parseValue, personDealSpecs, postedValue } from "./record-form.ts";
import { fieldId } from "./record-fields.ts";
import { withChange } from "./return-to.ts";
import { MORNING, snoozePresets } from "./snooze.ts";
import { addTaskForm, quickSpecs, refusedQuickAdd, snoozeForms, type Subject, subjectHref, taskEditForm, taskEditSpecs, taskName, taskSpecs } from "./task-forms.ts";

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

const defsOf = (ctx: ActionContext): Promise<FieldDefRow[]> => listFieldDefs(ctx.db);

/** POST /deals/new: add_deal for a new person (or one whose email is on file). Then the new deal's page. */
async function newPersonDeal(ctx: ActionContext): Promise<ActionResult> {
  const collected = collectNew(personDealSpecs(await defsOf(ctx)), ctx.form);
  const cancel = addReturn(ctx.form.get(RETURN_FIELD), "/pipeline");
  const refused = async (extra: string[] = []) =>
    page(422, await personDealPage(pageContext(ctx, PERSON_DEAL_PATH), stateOf(collected, extra), cancel));
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addDeal(asOwner(ctx, "add_deal"), collected.input as DealInput);
    return redirect(withChange(dealHref(result.dealId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "deal")]);
  }
}

/** POST /contacts/<id>/deals/new: add_deal with that contact. Then the new deal's page. */
async function newDeal(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = isContactId(id) ? await getContact(ctx.db, id) : null;
  if (contact === null || contact.archived === 1) return notFound(ctx);
  const collected = collectNew(newDealSpecs(await defsOf(ctx)), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await newDealPage(pageContext(ctx, newDealPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addDeal(asOwner(ctx, "add_deal"), { ...(collected.input as DealInput), contact: contact.id });
    return redirect(withChange(dealHref(result.dealId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "deal")]);
  }
}

/** POST /contacts/new: add_contact with the person status and sub-status chosen. Then the new contact's page. */
async function newContact(ctx: ActionContext): Promise<ActionResult> {
  const collected = collectNew(await newContactSpecs(ctx.db), ctx.form);
  const input = collected.input as Partial<NewContactInput>;
  if (collected.errors.length === 0) checkSubStatus(collected, input.personStatus ?? CONTACT, await listPersonStatuses(ctx.db));
  const cancel = addReturn(ctx.form.get(RETURN_FIELD), "/contacts");
  const refused = async (extra: string[] = []) => page(422, await contactNewPage(pageContext(ctx, CONTACT_PATH), stateOf(collected, extra), cancel));
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addContact(asOwner(ctx, "add_contact"), collected.input as unknown as NewContactInput);
    return redirect(withChange(contactHref(result.contactId), result.changeId));
  } catch (error) {
    // A lead is added as Add a lead adds one (decision 0041); its duplicate answers are said in the board's words.
    if (error instanceof DuplicateLeadError) {
      const message =
        error.by === "email"
          ? `${error.who} already uses that email, so they are on file already.`
          : `${error.who} already has that account. To add another lead anyway, use Add a lead and tick Add anyway.`;
      fieldError(collected, error.by, message);
      return refused();
    }
    return refused([refusal(error, "contact")]);
  }
}

/** POST /contacts/<id>/edit: update_contact with only the fields the owner changed. */
async function editContact(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = isContactId(id) ? await getContact(ctx.db, id) : null;
  if (contact === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const collected = await collectEdit(await contactEditSpecs(ctx.db), ctx.form, personRow(contact), tz);
  const status = (collected.input as ContactPatch).personStatus ?? contact.person_status;
  if (collected.errors.length === 0) checkSubStatus(collected, status, await listPersonStatuses(ctx.db));
  const refused = async (extra: string[] = []) =>
    page(422, (await contactEditPage(pageContext(ctx, contactEditPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateContact(asOwner(ctx, "update_contact"), contact.id, collected.input as ContactPatch);
    return redirect(withChange(backTo(ctx, contactHref(contact.id)), result.changeId));
  } catch (error) {
    return refused([refusal(error, "contact")]);
  }
}

/** POST /deals/<id>/edit: update_deal with only the fields the owner changed (never the stage). */
async function editDeal(ctx: ActionContext, id: string): Promise<ActionResult> {
  const deal = isDealId(id) ? await getDeal(ctx.db, id) : null;
  if (deal === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const collected = await collectEdit(dealSpecs(await defsOf(ctx), { titleRequired: true, notes: false }), ctx.form, deal, tz);
  const refused = async (extra: string[] = []) =>
    page(422, (await dealEditPage(pageContext(ctx, dealEditPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateDeal(asOwner(ctx, "update_deal"), deal.id, collected.input as DealPatch);
    return redirect(withChange(backTo(ctx, dealHref(deal.id)), result.changeId));
  } catch (error) {
    return refused([refusal(error, "deal")]);
  }
}

/** The deal, contact or project a task or log post is about, or null when there is none with that id (or projects are off). */
async function subjectOf(ctx: ActionContext, kind: Subject["kind"], id: string): Promise<Subject | null> {
  if (kind === "deal") return isDealId(id) && (await getDeal(ctx.db, id)) !== null ? { kind, id } : null;
  if (kind === "project") {
    return isProjectId(id) && (await getSettings(ctx.db)).projects === 1 && (await projectById(ctx.db, id)) !== null ? { kind, id } : null;
  }
  return isContactId(id) && (await getContact(ctx.db, id)) !== null ? { kind, id } : null;
}

const subjectRefs = (subject: Subject) =>
  subject.kind === "deal" ? { dealId: subject.id } : subject.kind === "project" ? { project: subject.id } : { contactId: subject.id };

/** POST /deals/<id>/tasks, /contacts/<id>/tasks and /projects/<id>/tasks: add_task. */
export const addTaskTo = (kind: Subject["kind"]) =>
  async function addTaskRoute(ctx: ActionContext, id: string): Promise<ActionResult> {
    const subject = await subjectOf(ctx, kind, id);
    if (subject === null) return notFound(ctx);
    const back = backTo(ctx, subjectHref(subject));
    const collected = collectNew(taskSpecs(), ctx.form);
    const refused = (extra: string[] = []) =>
      page(
        422,
        refusedFormPage(ctx, "The task wasn't added", addTaskForm(subject, { csrf: ctx.csrf, here: back }, stateOf(collected, extra)), back, subjectHref(subject)),
      );
    if (collected.errors.length > 0) return refused();
    try {
      const input = collected.input as { title: string; dueAt?: string; description?: string };
      const result = await addTask(asOwner(ctx, "add_task"), { ...subjectRefs(subject), ...input });
      return redirectBack(ctx, withChange(back, result.changeId));
    } catch (error) {
      return refused([refusal(error, "task")]);
    }
  };

/** POST /tasks/quick: add_task with no deal or contact (decision 0047), from the form at the top of Today. */
async function quickAdd(ctx: ActionContext): Promise<ActionResult> {
  const back = backTo(ctx, "/");
  const collected = collectNew(quickSpecs(), ctx.form);
  const refused = (extra: string[] = []) =>
    page(422, refusedFormPage(ctx, "The to-do wasn't added", refusedQuickAdd({ csrf: ctx.csrf, here: back }, stateOf(collected, extra)), back, "/"));
  if (collected.errors.length > 0) return refused();
  try {
    const input = collected.input as { title: string; dueAt?: string };
    const result = await addTask(asOwner(ctx, "add_task"), { title: input.title, dueAt: input.dueAt });
    return redirectBack(ctx, withChange(back, result.changeId));
  } catch (error) {
    return refused([refusal(error, "task")]);
  }
}

/**
 * POST /deals/<id>/log and /contacts/<id>/log: log_activity. Task R5's one-tap logging posts here too; its Text button
 * sends via=text, passed on only when it is exactly that, so the note counts as reaching a lead (decision 0022).
 */
export const logOn = (kind: Subject["kind"]) =>
  async function logRoute(ctx: ActionContext, id: string): Promise<ActionResult> {
    const subject = await subjectOf(ctx, kind, id);
    if (subject === null) return notFound(ctx);
    const back = backTo(ctx, subjectHref(subject));
    const collected = collectNew(logSpecs(), ctx.form);
    const input = collected.input as { type?: ActivityType; summary?: string; occurredAt?: string };
    // A date with no time would log it at midnight; blank means now.
    if (input.occurredAt !== undefined && !input.occurredAt.includes("T")) {
      fieldError(collected, "when", "Give the time too, or leave both blank for now.");
    }
    const refused = (extra: string[] = []) =>
      page(422, refusedFormPage(ctx, "Nothing was logged", logForm(subject, { csrf: ctx.csrf, here: back }, stateOf(collected, extra)), back, subjectHref(subject)));
    if (collected.errors.length > 0) return refused();
    try {
      const result = await logActivity(asOwner(ctx, "log_activity"), {
        ...subjectRefs(subject),
        type: input.type ?? "note",
        summary: input.summary ?? "",
        occurredAt: input.occurredAt,
        ...(ctx.form.get("via") === "text" ? { via: "text" as const } : {}),
      });
      return redirect(withChange(back, result.changeId));
    } catch (error) {
      return refused([refusal(error, "record")]);
    }
  };

/** A task's own page to come back to: its deal, else its contact, else Today. */
async function taskHome(
  ctx: ActionContext,
  taskId: string,
): Promise<{ back: string; home: string; found: boolean; title: string; untrusted: string }> {
  const task = isTaskId(taskId) ? await getTask(ctx.db, taskId) : null;
  if (task === null) return { back: "/", home: "/", found: false, title: "", untrusted: "[]" };
  const home = task.deal_id !== null ? dealHref(task.deal_id) : task.contact_id !== null ? contactHref(task.contact_id) : "/";
  return { back: backTo(ctx, home), home, found: true, title: task.title, untrusted: task.untrusted_fields };
}

/** The question a task with open sub-tasks asks before it is done (no sub-task text is shown, only the count). */
function subTasksPage(ctx: ActionContext, id: string, task: { title: string; untrusted: string }, open: number, back: string): string {
  const name = taskName({ id, title: task.title, untrusted_fields: task.untrusted });
  const form: FormContext = { csrf: ctx.csrf, here: back };
  const choice = (value: string, label: string, className: string) =>
    postForm("confirm", `/tasks/${id}/complete`, form, html`${hidden("subtasks", value)}<button class="${className}" type="submit">${label}</button>`);
  return renderPage({
    title: "Complete its sub-tasks too?",
    description: "This task has open sub-tasks. Complete them too, or only this task, or cancel to go back.",
    frame: { look: ctx.look },
    body: html`<h1>Complete its sub-tasks too?</h1>
<p class="lede">${name} has ${count(open, "open sub-task")}.</p>
<div class="confirm-actions">
${choice("complete", "Complete them too", "button")}
${choice("leave", "Only this task", "button")}
<a class="confirm-cancel" href="${back}">Cancel</a>
</div>`,
  });
}

/** POST /tasks/<id>/complete: complete_task, one tap; a task with open sub-tasks asks first. */
async function complete(ctx: ActionContext, id: string): Promise<ActionResult> {
  const home = await taskHome(ctx, id);
  if (!home.found) return notFound(ctx);
  try {
    const asked = ctx.form.get("subtasks");
    const subTasks = asked === "complete" || asked === "leave" ? asked : undefined;
    if (subTasks === undefined) {
      const open = (await descendants(ctx.db, id)).filter((kid) => kid.done_at === null).length;
      if (open > 0 && (await getTask(ctx.db, id))?.done_at === null) return page(200, subTasksPage(ctx, id, home, open, home.back));
    }
    const result = await completeTask(asOwner(ctx, "complete_task"), id, { subTasks });
    return redirectBack(ctx, withChange(home.back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The task wasn't marked done", refusal(error, "task"), home.back, "", home.home));
  }
}

const untilSpec = line("until", "Or until", "when", "deal");

/** POST /tasks/<id>/snooze: snooze_task to a preset (9:00 tomorrow, next Monday 9:00) or a date and time. */
async function snooze(ctx: ActionContext, id: string): Promise<ActionResult> {
  const home = await taskHome(ctx, id);
  if (!home.found) return notFound(ctx);
  const task = { id, title: home.title, untrusted_fields: home.untrusted };
  const preset = ctx.form.get("preset");
  const posted = postedValue(ctx.form, untilSpec) ?? "";
  const refused = (message: string, onField: boolean) =>
    page(
      422,
      refusedFormPage(
        ctx,
        "The task wasn't snoozed",
        html`${errorSummary([onField ? { id: `${fieldId("snooze", id)}-date`, message } : { message }])}<div class="card refused-form">${snoozeForms(task, { csrf: ctx.csrf, here: home.back }, onField ? { until: posted, error: message } : { until: posted })}</div>`,
        home.back,
        home.home,
      ),
    );
  let until: string;
  if (preset === "tomorrow" || preset === "next_week") {
    const presets = snoozePresets(ctx.now, await ownerTimezone(ctx.db));
    until = preset === "tomorrow" ? presets.tomorrow : presets.nextWeek;
  } else {
    if (posted === "" || posted.startsWith("T")) return refused("Give a date to snooze it until.", true);
    const parsed = parseValue(untilSpec, posted);
    if (!parsed.ok) return refused(parsed.message, true);
    until = posted.includes("T") ? posted : `${posted}T${MORNING}`;
  }
  try {
    const result = await snoozeTask(asOwner(ctx, "snooze_task"), id, until);
    return redirectBack(ctx, withChange(home.back, result.changeId));
  } catch (error) {
    return refused(refusal(error, "task"), preset !== "tomorrow" && preset !== "next_week");
  }
}

/** POST /tasks/<id>/edit: update_task with only the fields the owner changed (a cleared Due or Description is null). */
async function editTask(ctx: ActionContext, id: string): Promise<ActionResult> {
  const home = await taskHome(ctx, id);
  const row = home.found ? await getTask(ctx.db, id) : null;
  if (row === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const collected = await collectEdit(taskEditSpecs(), ctx.form, { ...row, fields: "{}" }, tz);
  const refused = async (extra: string[] = []) => {
    const state = stateOf(collected, extra);
    const form = await taskEditForm({ id, title: row.title, dueAt: row.due_at, description: row.description ?? null, untrusted_fields: row.untrusted_fields }, { csrf: ctx.csrf, here: home.back }, tz, state);
    return page(422, refusedFormPage(ctx, "The task wasn't saved", form, home.back, "/"));
  };
  if (collected.errors.length > 0) return refused();
  if (Object.keys(collected.input).length === 0) return refused([NOTHING_TO_SAVE]);
  try {
    const result = await updateTask(asOwner(ctx, "update_task"), id, collected.input as { title?: string; dueAt?: string | null; description?: string | null });
    return redirectBack(ctx, withChange(home.back, result.changeId));
  } catch (error) {
    return refused([refusal(error, "task")]);
  }
}

export const EDIT_ROUTES: Route[] = [
  { path: /^\/deals\/(new)$/, handle: (ctx) => newPersonDeal(ctx), big: true },
  { path: /^\/contacts\/([^/]+)\/deals\/new$/, handle: newDeal, big: true },
  { path: /^\/contacts\/(new)$/, handle: (ctx) => newContact(ctx), big: true },
  { path: /^\/contacts\/([^/]+)\/edit$/, handle: editContact, big: true },
  { path: /^\/deals\/([^/]+)\/edit$/, handle: editDeal, big: true },
  { path: /^\/deals\/([^/]+)\/tasks$/, handle: addTaskTo("deal") },
  { path: /^\/contacts\/([^/]+)\/tasks$/, handle: addTaskTo("contact") },
  { path: /^\/tasks\/(quick)$/, handle: (ctx) => quickAdd(ctx) },
  { path: /^\/deals\/([^/]+)\/log$/, handle: logOn("deal"), big: true },
  { path: /^\/contacts\/([^/]+)\/log$/, handle: logOn("contact"), big: true },
  { path: /^\/tasks\/([^/]+)\/complete$/, handle: complete },
  { path: /^\/tasks\/([^/]+)\/snooze$/, handle: snooze },
  { path: /^\/tasks\/([^/]+)\/edit$/, handle: editTask, big: true },
];

