// The board's editing posts (decision 0018): New lead, a new deal for a contact, Edit contact, Edit deal, Add a task,
// Done, Snooze and Log. Each calls the service the matching MCP tool calls, as the owner under that tool's name, and
// answers 303 back with ?change=. A refused post draws its form again (422) with the values kept and the errors.
import type { ActivityType, FieldDefRow } from "../db/db.ts";
import { getContact, getDeal, getTask, listFieldDefs } from "../db/queries.ts";
import { isContactId, isDealId, isTaskId } from "../ids.ts";
import { logActivity } from "../services/activities.ts";
import { StaleWriteError } from "../services/change.ts";
import { type DealPatch, updateDeal } from "../services/deals.ts";
import { UserError } from "../services/errors.ts";
import { addLead, type ContactPatch, type LeadInput, updateContact } from "../services/leads.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { addTask, completeTask, snoozeTask } from "../services/tasks.ts";
import {
  type ActionContext,
  type ActionResult,
  asOwner,
  backTo,
  notFound,
  page,
  pageContext,
  redirect,
  refusedFormPage,
  refusedPage,
} from "./action-kit.ts";
import { RETURN_FIELD } from "./forms.ts";
import { html } from "./html.ts";
import { errorSummary } from "./inputs.ts";
import { logForm, logSpecs } from "./log-form.ts";
import { contactEditPage, contactEditPath } from "./pages/contact-edit.ts";
import { dealEditPage, dealEditPath } from "./pages/deal-edit.ts";
import { newDealPage, newDealPath, newDealSpecs } from "./pages/deal-new.ts";
import { LEAD_PATH, leadPage, leadReturn } from "./pages/lead-new.ts";
import type { FormState } from "./pages/record-page.ts";
import { contactHref, dealHref } from "./parts.ts";
import { type Collected, collectEdit, collectNew, contactSpecs, dealSpecs, leadSpecs, line, parseValue, postedValue } from "./record-form.ts";
import { fieldId } from "./record-fields.ts";
import { withChange } from "./return-to.ts";
import { MORNING, snoozePresets } from "./snooze.ts";
import { addTaskForm, snoozeForms, type Subject, subjectHref, taskSpecs } from "./task-forms.ts";

type Route = { path: RegExp; handle: (ctx: ActionContext, id: string) => Promise<ActionResult> };

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

const stateOf = (collected: Collected, extra: string[] = []): FormState => ({
  shown: collected.shown,
  errors: [...collected.errors, ...extra.map((message) => ({ message }))],
});

/** A service's refusal, in words for the board: a write that lost a race says so without naming tool calls. */
function refusal(error: unknown, what: string): string {
  if (error instanceof StaleWriteError) return `This ${what} was changed while you were saving, so nothing was saved. Check the form and save again.`;
  if (error instanceof UserError) return error.message;
  throw error;
}

/** Marks one field of a collected form as wrong. */
function fieldError(collected: Collected, name: string, message: string): void {
  collected.errors.push({ name, message });
  const item = collected.shown.get(name);
  if (item !== undefined) item.error = message;
}

const defsOf = (ctx: ActionContext): Promise<FieldDefRow[]> => listFieldDefs(ctx.db);

/** POST /leads/new: add_lead. Then the new deal's page. */
async function newLead(ctx: ActionContext): Promise<ActionResult> {
  const collected = collectNew(leadSpecs(await defsOf(ctx)), ctx.form);
  const cancel = leadReturn(ctx.form.get(RETURN_FIELD));
  const refused = async (extra: string[] = []) =>
    page(422, await leadPage(pageContext(ctx, LEAD_PATH), stateOf(collected, extra), cancel));
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addLead(asOwner(ctx, "add_lead"), collected.input as LeadInput);
    return redirect(withChange(dealHref(result.dealId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "lead")]);
  }
}

/** POST /contacts/<id>/deals/new: add_lead with that contact. Then the new deal's page. */
async function newDeal(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = isContactId(id) ? await getContact(ctx.db, id) : null;
  if (contact === null) return notFound(ctx);
  const collected = collectNew(newDealSpecs(await defsOf(ctx)), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await newDealPage(pageContext(ctx, newDealPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addLead(asOwner(ctx, "add_lead"), { ...(collected.input as LeadInput), contact: contact.id });
    return redirect(withChange(dealHref(result.dealId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "deal")]);
  }
}

/** POST /contacts/<id>/edit: update_contact with only the fields the owner changed. */
async function editContact(ctx: ActionContext, id: string): Promise<ActionResult> {
  const contact = isContactId(id) ? await getContact(ctx.db, id) : null;
  if (contact === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const collected = await collectEdit(contactSpecs(await defsOf(ctx)), ctx.form, contact, tz);
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

/** The deal or contact a task or log post is about, or null when there is none with that id. */
async function subjectOf(ctx: ActionContext, kind: Subject["kind"], id: string): Promise<Subject | null> {
  if (kind === "deal") return isDealId(id) && (await getDeal(ctx.db, id)) !== null ? { kind, id } : null;
  return isContactId(id) && (await getContact(ctx.db, id)) !== null ? { kind, id } : null;
}

const subjectRefs = (subject: Subject) => (subject.kind === "deal" ? { dealId: subject.id } : { contactId: subject.id });

/** POST /deals/<id>/tasks and /contacts/<id>/tasks: add_task. */
const addTaskTo = (kind: Subject["kind"]) =>
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
      const input = collected.input as { title: string; dueAt?: string };
      const result = await addTask(asOwner(ctx, "add_task"), { ...subjectRefs(subject), title: input.title, dueAt: input.dueAt });
      return redirect(withChange(back, result.changeId));
    } catch (error) {
      return refused([refusal(error, "task")]);
    }
  };

/** POST /deals/<id>/log and /contacts/<id>/log: log_activity. Task R5's one-tap logging posts here too. */
const logOn = (kind: Subject["kind"]) =>
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
      });
      return redirect(withChange(back, result.changeId));
    } catch (error) {
      return refused([refusal(error, "record")]);
    }
  };

/** A task's own page to come back to: its deal, else its contact, else Today. */
async function taskHome(ctx: ActionContext, taskId: string): Promise<{ back: string; found: boolean; title: string; untrusted: string }> {
  const task = isTaskId(taskId) ? await getTask(ctx.db, taskId) : null;
  if (task === null) return { back: "/", found: false, title: "", untrusted: "[]" };
  const home = task.deal_id !== null ? dealHref(task.deal_id) : task.contact_id !== null ? contactHref(task.contact_id) : "/";
  return { back: backTo(ctx, home), found: true, title: task.title, untrusted: task.untrusted_fields };
}

/** POST /tasks/<id>/complete: complete_task, one tap. */
async function complete(ctx: ActionContext, id: string): Promise<ActionResult> {
  const home = await taskHome(ctx, id);
  if (!home.found) return notFound(ctx);
  try {
    const result = await completeTask(asOwner(ctx, "complete_task"), id);
    return redirect(withChange(home.back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The task wasn't marked done", refusal(error, "task"), home.back, ""));
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
    return redirect(withChange(home.back, result.changeId));
  } catch (error) {
    return refused(refusal(error, "task"), preset !== "tomorrow" && preset !== "next_week");
  }
}

export const EDIT_ROUTES: Route[] = [
  { path: /^\/leads\/(new)$/, handle: (ctx) => newLead(ctx) },
  { path: /^\/contacts\/([^/]+)\/deals\/new$/, handle: newDeal },
  { path: /^\/contacts\/([^/]+)\/edit$/, handle: editContact },
  { path: /^\/deals\/([^/]+)\/edit$/, handle: editDeal },
  { path: /^\/deals\/([^/]+)\/tasks$/, handle: addTaskTo("deal") },
  { path: /^\/contacts\/([^/]+)\/tasks$/, handle: addTaskTo("contact") },
  { path: /^\/deals\/([^/]+)\/log$/, handle: logOn("deal") },
  { path: /^\/contacts\/([^/]+)\/log$/, handle: logOn("contact") },
  { path: /^\/tasks\/([^/]+)\/complete$/, handle: complete },
  { path: /^\/tasks\/([^/]+)\/snooze$/, handle: snooze },
];

