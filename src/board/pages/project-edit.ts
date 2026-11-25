// /projects/<id>/edit (decision 0055): change a project's name, status, dates or notes (update_project). Only the fields
// the owner changes are saved (decision 0018). 404 while projects are off and for an id that is no project's; an archived
// project can still be edited.
import { getSettings } from "../../db/queries.ts";
import { isProjectId } from "../../ids.ts";
import { ownerTimezone, projectById } from "../../services/lookup.ts";
import { projectStatusRows } from "../../services/memo.ts";
import type { PageContext } from "../context.ts";
import { projectHref } from "../parts.ts";
import { PROJECT_PREFIX, projectSavePath, projectSpecs } from "../project-form.ts";
import { editShown } from "../record-form.ts";
import { type FormState, recordFormPage } from "./record-page.ts";
import { projectEditPath } from "./project.ts";

export async function projectEditPage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  if ((await getSettings(ctx.db)).projects !== 1 || !isProjectId(id)) return null;
  const project = await projectById(ctx.db, id);
  if (project === null) return null;
  const tz = await ownerTimezone(ctx.db);
  const specs = projectSpecs(await projectStatusRows(ctx.db));
  const shown = state?.shown ?? (await editShown(specs, { ...project, fields: "{}" }, tz));
  const back = projectHref(project.id);
  return recordFormPage(ctx, {
    title: "Edit project",
    description: "Change a project's name, status, start and target dates or notes.",
    heading: "Edit project",
    lede: "Change what you need and save. A date's time is optional.",
    current: projectEditPath(project.id),
    back: { href: back, text: "Back to the project" },
    action: projectSavePath(project.id),
    cancel: back,
    submit: "Save changes",
    prefix: PROJECT_PREFIX,
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
  });
}
