// The project page's posts (decision 0055): Save status and Archive or Bring back (update_project), Add a task
// (add_task) and Log it (log_activity). Each calls the service the matching MCP tool calls, as the owner under that tool's
// name. While projects are off, or for an id that is no project, every path here is a 404.
import { getSettings } from "../db/queries.ts";
import { isProjectId } from "../ids.ts";
import { projectById } from "../services/lookup.ts";
import { projectStatusRows } from "../services/memo.ts";
import { updateProject } from "../services/projects.ts";
import { type ActionContext, type ActionResult, asOwner, backTo, notFound, page, redirect, refusal, refusedPage, type Route } from "./action-kit.ts";
import { addTaskTo, logOn } from "./edit-actions.ts";
import { projectHref } from "./parts.ts";
import { statusForm } from "./pages/project.ts";
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
    const statuses = await projectStatusRows(ctx.db);
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

export const PROJECT_ROUTES: Route[] = [
  { path: /^\/projects\/([^/]+)\/status$/, handle: saveStatus },
  { path: /^\/projects\/([^/]+)\/archive$/, handle: archive },
  { path: /^\/projects\/([^/]+)\/tasks$/, handle: addTaskTo("project") },
  { path: /^\/projects\/([^/]+)\/log$/, handle: logOn("project"), big: true },
];
