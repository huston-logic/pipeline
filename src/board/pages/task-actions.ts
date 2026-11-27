// /tasks/<id>/actions: one open task row's actions, for public/live.js to put into the row when it opens (run 12), so
// the page's own text is never parsed as markup. Not a page for the owner (not in boardRoutes): the row's <noscript>
// draws the same forms with scripts off. `back` is the page the row is on, where every form comes back to; `tree`,
// `up` and `down` say how the row was drawn there (task-row.ts actionsHref).
import { openTaskItem } from "../../services/read.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { herePath, type PageContext } from "../context.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { boardReturnPath } from "../return-to.ts";
import { type RowTask, rowActions } from "../task-row.ts";

export const TASK_ACTIONS_PATH = /^\/tasks\/([^/]+)\/actions$/;

const BASE = "http://board.invalid";
const LEVELS = new Map<string, RowTask["level"]>([
  ["1", 1],
  ["2", 2],
  ["3", 3],
]);

/** The row's page without its change id; anything that is not a board page, or is this route, is Today. */
function backOf(query: URLSearchParams): string {
  const path = boardReturnPath(query.get("back"));
  if (path === null) return "/";
  const url = new URL(path, BASE);
  return TASK_ACTIONS_PATH.test(url.pathname) ? "/" : herePath(url);
}

export async function taskActionsPage(ctx: PageContext, id: string): Promise<string | null> {
  const tz = await ownerTimezone(ctx.db);
  const task = await openTaskItem(ctx.db, id, tz);
  if (task === null) return null;
  const level = LEVELS.get(ctx.query.get("tree") ?? "");
  const onProject = level !== undefined && task.projectId !== null;
  const row: RowTask = {
    ...task,
    level: level ?? 1,
    onProject,
    hasSiblingsBefore: ctx.query.get("up") === "1",
    hasSiblingsAfter: ctx.query.get("down") === "1",
  };
  const back = backOf(ctx.query);
  const form = { csrf: ctx.csrf, here: back, startTimer: ctx.startTimer === true };
  return renderPage({
    title: "Task actions",
    description: "Start timer, Snooze and Edit for one task.",
    frame: { ...ctx, here: back },
    body: html`<h1>Task actions</h1>
<p class="back"><a href="${back}">Back</a></p>
<div data-region="actions-${task.id}">${await rowActions(row, form, tz)}</div>`,
  });
}
