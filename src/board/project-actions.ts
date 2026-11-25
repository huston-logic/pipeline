// The project page's posts (decision 0055): Save status and Archive or Bring back (update_project), Add a task
// (add_task) and Log it (log_activity). Each calls the service the matching MCP tool calls, as the owner under that tool's
// name. While projects are off, or for an id that is no project, every path here is a 404.
import { getContact, getSettings, listFieldDefs } from "../db/queries.ts";
import { isContactId, isProjectId } from "../ids.ts";
import { ownerTimezone, projectById } from "../services/lookup.ts";
import { projectStatusRows } from "../services/memo.ts";
import { addProject, type ProjectPatch, updateProject } from "../services/projects.ts";
import { type ActionContext, type ActionResult, asOwner, backTo, notFound, page, pageContext, redirect, refusal, refusedPage, type Route, stateOf } from "./action-kit.ts";
import type { PageContext } from "./context.ts";
import { addTaskTo, logOn } from "./edit-actions.ts";
import { projectHref } from "./parts.ts";
import { projectEditPage } from "./pages/project-edit.ts";
import { newInternalProjectPage, newProjectOfContactPage, newProjectOfDealPage, wonDeal } from "./pages/project-new.ts";
import { projectEditPath, statusForm } from "./pages/project.ts";
import { COMPLETE_TASKS, MOVE_TASKS, newInternalProjectPath, newProjectOfContactPath, newProjectOfDealPath, projectSpecs, statusChoices } from "./project-form.ts";
import { collectEdit, collectNew } from "./record-form.ts";
import { withChange } from "./return-to.ts";

/** The project a post names, or null when projects are off or there is none with that id. */
async function projectOf(ctx: ActionContext, id: string) {
  if (!isProjectId(id) || (await getSettings(ctx.db)).projects !== 1) return null;
  return projectById(ctx.db, id);
}

/** POST /projects/<id>/status: update_project with the status. */
async function saveStatus(ctx: ActionContext, id: string): Promise<ActionResult> {
  const project = await projectOf(ctx, id);
  if (project === null) return notFound(ctx);
  const back = backTo(ctx, projectHref(project.id));
  const asked = (ctx.form.get("status") ?? "").trim();
  try {
    const result = await updateProject(asOwner(ctx, "update_project"), project.id, { status: asked });
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    const statuses = await statusChoices(ctx.db, project.status_key);
    const form = statusForm(project.id, statuses, { csrf: ctx.csrf, here: back }, asked);
    return page(422, refusedPage(ctx, "The status wasn't saved", refusal(error, "project"), back, form, projectHref(project.id)));
  }
}

/** POST /projects/<id>/archive: update_project with archived 1 (Archive) or 0 (Bring back). */
async function archive(ctx: ActionContext, id: string): Promise<ActionResult> {
  const project = await projectOf(ctx, id);
  if (project === null) return notFound(ctx);
  const back = backTo(ctx, projectHref(project.id));
  try {
    const result = await updateProject(asOwner(ctx, "update_project"), project.id, { archived: ctx.form.get("archived") === "1" });
    return redirect(withChange(back, result.changeId));
  } catch (error) {
    return page(422, refusedPage(ctx, "The project wasn't changed", refusal(error, "project"), back, "", projectHref(project.id)));
  }
}

const NOTHING_TO_SAVE = "Nothing to save: every field is as it was. Change a value, or cancel to go back.";

/** A project form's page context: projects are on (the paths 404 otherwise), so More lists Projects on a refused form too. */
const formContext = (ctx: ActionContext, here: string): PageContext => ({ ...pageContext(ctx, here), projects: true });

const projectsOn = async (ctx: ActionContext): Promise<boolean> => (await getSettings(ctx.db)).projects === 1;

type FormInput = { name?: string; status?: string; startAt?: string; targetAt?: string; notes?: string; fields?: Record<string, string | number> };

/** The new-project form's specs: the live statuses and the live custom project fields. */
const specsOf = async (ctx: ActionContext) =>
  projectSpecs(await projectStatusRows(ctx.db), { defs: await listFieldDefs(ctx.db, { entity: "project" }) });

/** POST /projects/new: add_project with no person and no deal (an internal project). */
async function addInternal(ctx: ActionContext): Promise<ActionResult> {
  if (!(await projectsOn(ctx))) return notFound(ctx);
  const collected = collectNew(await specsOf(ctx), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await newInternalProjectPage(formContext(ctx, newInternalProjectPath), stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addProject(asOwner(ctx, "add_project"), collected.input as FormInput);
    return redirect(withChange(projectHref(result.projectId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "project")]);
  }
}

/** POST /contacts/<id>/projects: add_project for that person. Then the new project's page. */
async function addOfContact(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!(await projectsOn(ctx)) || !isContactId(id)) return notFound(ctx);
  const contact = await getContact(ctx.db, id);
  if (contact === null || contact.archived === 1) return notFound(ctx);
  const collected = collectNew(await specsOf(ctx), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await newProjectOfContactPage(formContext(ctx, newProjectOfContactPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const result = await addProject(asOwner(ctx, "add_project"), { ...(collected.input as FormInput), contact: contact.id });
    return redirect(withChange(projectHref(result.projectId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "project")]);
  }
}

/** POST /deals/<id>/projects: add_project from that won deal, moving its open tasks only when the box is ticked. */
async function addOfDeal(ctx: ActionContext, id: string): Promise<ActionResult> {
  if (!(await projectsOn(ctx))) return notFound(ctx);
  const deal = await wonDeal(ctx, id);
  if (deal === null) return notFound(ctx);
  const move = ctx.form.get(MOVE_TASKS) === "yes";
  const complete = ctx.form.get(COMPLETE_TASKS) === "yes";
  const collected = collectNew(await specsOf(ctx), ctx.form);
  const refused = async (extra: string[] = []) =>
    page(422, (await newProjectOfDealPage(formContext(ctx, newProjectOfDealPath(id)), id, { ...stateOf(collected, extra), move, complete })) ?? "");
  if (collected.errors.length > 0) return refused();
  try {
    const tasks = complete ? { completeOpenTasks: true } : move ? { moveOpenTasks: true } : {};
    const result = await addProject(asOwner(ctx, "add_project"), { ...(collected.input as FormInput), deal: deal.id, ...tasks });
    return redirect(withChange(projectHref(result.projectId), result.changeId));
  } catch (error) {
    return refused([refusal(error, "project")]);
  }
}

/** POST /projects/<id>: update_project with only the fields the owner changed. */
async function edit(ctx: ActionContext, id: string): Promise<ActionResult> {
  const project = await projectOf(ctx, id);
  if (project === null) return notFound(ctx);
  const tz = await ownerTimezone(ctx.db);
  const defs = await listFieldDefs(ctx.db, { entity: "project" });
  const specs = projectSpecs(await statusChoices(ctx.db, project.status_key), { defs });
  const collected = await collectEdit(specs, ctx.form, project, tz);
  const refused = async (extra: string[] = []) =>
    page(422, (await projectEditPage(formContext(ctx, projectEditPath(id)), id, stateOf(collected, extra))) ?? "");
  if (collected.errors.length > 0) return refused();
  const input = collected.input as FormInput & { startAt?: string | null; targetAt?: string | null; notes?: string | null };
  if (Object.keys(input).length === 0) return refused([NOTHING_TO_SAVE]);
  const patch: ProjectPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.status !== undefined) patch.status = input.status;
  if (input.startAt !== undefined) patch.startAt = input.startAt;
  if (input.targetAt !== undefined) patch.targetAt = input.targetAt;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.fields !== undefined) patch.fields = input.fields;
  try {
    const result = await updateProject(asOwner(ctx, "update_project"), project.id, patch);
    return redirect(withChange(projectHref(project.id), result.changeId));
  } catch (error) {
    return refused([refusal(error, "project")]);
  }
}

export const PROJECT_ROUTES: Route[] = [
  { path: /^\/projects\/(new)$/, handle: (ctx) => addInternal(ctx), big: true },
  { path: /^\/contacts\/([^/]+)\/projects$/, handle: addOfContact, big: true },
  { path: /^\/deals\/([^/]+)\/projects$/, handle: addOfDeal, big: true },
  { path: /^\/projects\/([^/]+)$/, handle: edit, big: true },
  { path: /^\/projects\/([^/]+)\/status$/, handle: saveStatus },
  { path: /^\/projects\/([^/]+)\/archive$/, handle: archive },
  { path: /^\/projects\/([^/]+)\/tasks$/, handle: addTaskTo("project") },
  { path: /^\/projects\/([^/]+)\/log$/, handle: logOn("project"), big: true },
];
