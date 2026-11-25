// /contacts/<id>/projects/new and /deals/<id>/projects/new (decision 0055): start a project for a person, or from a won
// deal (add_project). 404 while projects are off, for an unknown or archived person, and for a deal that is not won or is
// archived. A deal title from outside is never put in the name; the owner names the project.
import type { ContactRow, DealRow } from "../../db/db.ts";
import { getContact, getSettings } from "../../db/queries.ts";
import { isContactId, isDealId } from "../../ids.ts";
import { contactName, isTrusted } from "../../services/labels.ts";
import { dealById, openTasksOfDeal } from "../../services/lookup.ts";
import { projectStatusRows } from "../../services/memo.ts";
import type { PageContext } from "../context.ts";
import { type Html, html } from "../html.ts";
import { checkbox } from "../inputs.ts";
import { contactHref, dealHref } from "../parts.ts";
import { PROJECTS_PATH } from "./projects.ts";
import {
  addProjectOfContactPath,
  addProjectOfDealPath,
  COMPLETE_TASKS,
  MOVE_TASKS,
  newInternalProjectPath,
  newProjectOfContactPath,
  newProjectOfDealPath,
  PROJECT_PREFIX,
  projectFieldDefs,
  projectSpecs,
} from "../project-form.ts";
import type { Shown } from "../record-form.ts";
import { templateChoice } from "../template-choice.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

/** A refused form's state, with whether the move and complete boxes were ticked. */
export type NewProjectState = FormState & { move?: boolean; complete?: boolean; template?: string };

/** The template choice for a screen: the one in a refused post's state, else the address's `template`. */
const choiceFor = (ctx: PageContext, path: string, state?: NewProjectState) =>
  templateChoice(ctx.db, path, state?.template ?? ctx.query.get("template"), ctx.timeTracking === true);

const OUTSIDE_NAME_HINT = "The deal's title came from outside. Name the project in a few words.";

const openTasksText = (n: number): string => `${n} open task${n === 1 ? "" : "s"}`;

/** The default shown values: Active, and a trusted deal title as the name. */
function firstShown(name: string): Map<string, Shown> {
  return new Map([
    ["name", { value: name, outside: false }],
    ["status", { value: "active", outside: false }],
  ]);
}

export async function newProjectOfContactPage(ctx: PageContext, id: string, state?: NewProjectState): Promise<string | null> {
  if ((await getSettings(ctx.db)).projects !== 1 || !isContactId(id)) return null;
  const contact: ContactRow | null = await getContact(ctx.db, id);
  if (contact === null || contact.archived === 1) return null;
  const who = contactName(contact);
  const back = contactHref(contact.id);
  const choice = await choiceFor(ctx, newProjectOfContactPath(contact.id), state);
  return recordFormPage(ctx, {
    above: choice.above,
    title: `New project for ${who}`,
    description: `Start a project for ${who}: a name, a status, a start and target date, and notes.`,
    heading: `New project for ${who}`,
    lede: "A project is the work you do after a sale. Add its tasks and time on its page.",
    current: newProjectOfContactPath(contact.id),
    back: { href: back, text: "Back to the contact" },
    action: addProjectOfContactPath(contact.id),
    cancel: back,
    submit: "Add the project",
    prefix: PROJECT_PREFIX,
    groups: [{ specs: projectSpecs(await projectStatusRows(ctx.db), { defs: await projectFieldDefs(ctx.db) }), before: choice.hiddenField }],
    shown: state?.shown ?? firstShown(""),
    errors: state?.errors ?? [],
  });
}

/** /projects/new: an internal project, with no person and no deal. */
export async function newInternalProjectPage(ctx: PageContext, state?: NewProjectState): Promise<string | null> {
  if ((await getSettings(ctx.db)).projects !== 1) return null;
  const choice = await choiceFor(ctx, newInternalProjectPath, state);
  return recordFormPage(ctx, {
    above: choice.above,
    title: "Start a project",
    description: "Start a project of your own: a name, a status, a start and target date, and notes.",
    heading: "Start a project",
    lede: "An internal project has no person. Add its tasks and time on its page.",
    current: PROJECTS_PATH,
    back: { href: PROJECTS_PATH, text: "Back to projects" },
    action: newInternalProjectPath,
    cancel: PROJECTS_PATH,
    submit: "Add the project",
    prefix: PROJECT_PREFIX,
    groups: [{ specs: projectSpecs(await projectStatusRows(ctx.db), { defs: await projectFieldDefs(ctx.db) }), before: choice.hiddenField }],
    shown: state?.shown ?? firstShown(""),
    errors: state?.errors ?? [],
  });
}

/** A won, live deal by id, or null. */
export async function wonDeal(ctx: Pick<PageContext, "db">, id: string): Promise<DealRow | null> {
  const deal = isDealId(id) ? await dealById(ctx.db, id) : null;
  return deal === null || deal.status !== "won" || deal.archived === 1 ? null : deal;
}

const dealWords = (deal: DealRow): string => (isTrusted(deal, "title") ? deal.title : `deal ${deal.id}`);

export async function newProjectOfDealPage(ctx: PageContext, id: string, state?: NewProjectState): Promise<string | null> {
  if ((await getSettings(ctx.db)).projects !== 1) return null;
  const deal = await wonDeal(ctx, id);
  if (deal === null) return null;
  const trusted = isTrusted(deal, "title");
  const open = (await openTasksOfDeal(ctx.db, deal.id)).length;
  const fresh = state === undefined;
  const box: Html | undefined =
    open === 0
      ? undefined
      : html`<fieldset class="field field-when">
<legend>This deal's open tasks</legend>
${checkbox({
          id: "project-move-tasks",
          name: MOVE_TASKS,
          label: "Move open tasks to the project",
          value: "yes",
          checked: fresh || state.move === true,
          hint: `This deal has ${openTasksText(open)}.`,
        })}
${checkbox({
          id: "project-complete-tasks",
          name: COMPLETE_TASKS,
          label: "Complete all open tasks",
          value: "yes",
          checked: state?.complete === true,
          hint: "Marks them done and leaves them on the deal, instead of moving them.",
        })}
</fieldset>`;
  const words = dealWords(deal);
  const back = dealHref(deal.id);
  const choice = await choiceFor(ctx, newProjectOfDealPath(deal.id), state);
  return recordFormPage(ctx, {
    above: choice.above,
    title: `New project from ${words}`,
    description: `Start a project from a won deal: a name, a status, a start and target date, and notes.`,
    heading: `New project from ${words}`,
    lede: "The project keeps a link to this deal and its person.",
    current: newProjectOfDealPath(deal.id),
    back: { href: back, text: "Back to the deal" },
    action: addProjectOfDealPath(deal.id),
    cancel: back,
    submit: "Add the project",
    prefix: PROJECT_PREFIX,
    groups: [{ specs: projectSpecs(await projectStatusRows(ctx.db), { defs: await projectFieldDefs(ctx.db), ...(trusted ? {} : { nameHint: OUTSIDE_NAME_HINT }) }), before: choice.hiddenField, after: box }],
    shown: state?.shown ?? firstShown(trusted ? deal.title : ""),
    errors: state?.errors ?? [],
  });
}
