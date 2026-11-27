// /projects/<pj id> (decision 0055, run 12): one column. The head (name, status tag, Edit, Archive), the facts the owner
// chose (/projects/facts), Add a task, the open tasks with how many are done, Done behind a disclosure, and the notes.
// 404 while projects are off, for an unknown id or one that is no project's. A name from outside is labelled and never in
// the <title>, the description or a link's text.
import { getSettings, listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { getProject, type ProjectDetail, type TaskNode, TREE_TASK_LIMIT } from "../../services/project-read.ts";
import { UserError } from "../../services/errors.ts";
import { projectFacts } from "../../services/view-spec.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { logForm } from "../log-form.ts";
import { empty, labelled, pairs, projectHref, section, tag } from "../parts.ts";
import { factPairs } from "../project-fact-pairs.ts";
import { statusChoices } from "../project-form.ts";
import { taskList } from "../project-tree.ts";
import { outsideNote, timelineItem } from "../records.ts";
import { addTaskLine, type Subject } from "../task-forms.ts";
import { startTimerForm } from "../timer-start.ts";
import { PROJECT_FACTS_PATH } from "./project-facts.ts";

export const projectEditPath = (id: string): string => `${projectHref(id)}/edit`;

/** The Status select with its Save button; `selected` is the key to show (the stored one, or what a refused post sent). */
export function statusForm(id: string, statuses: { key: string; label: string }[], form: FormContext, selected: string): Html {
  return postForm(
    "project-status",
    `${projectHref(id)}/status`,
    form,
    html`<div class="field">
<label for="status-${id}">Status</label>
<select id="status-${id}" name="status">
${statuses.map((s) => html`<option value="${s.key}"${s.key === selected ? " selected" : ""}>${s.label}</option>\n`)}</select>
</div>
<button class="button button-small" type="submit">Save status</button>`,
  );
}

function archiveForm(project: ProjectDetail, form: FormContext): Html {
  return postForm(
    "project-archive",
    `${projectHref(project.id)}/archive`,
    form,
    html`${hidden("archived", project.archived ? "0" : "1")}<button class="button button-quiet button-small" type="submit">${project.archived ? "Bring back" : "Archive"}</button>`,
  );
}

function headRow(project: ProjectDetail, form: FormContext): Html {
  const status = project.archived ? `${project.statusLabel}, archived` : project.statusLabel;
  return html`<div class="project-head">
<h1>${labelled(project.name, project.untrusted_fields.includes("name"))}</h1>
${tag(status)}
<div class="project-actions"><a href="${projectEditPath(project.id)}">Edit</a>${archiveForm(project, form)}</div>
</div>`;
}

type Facts = { keys: string[]; labels: Map<string, string>; tz: string };

function factsBlock(project: ProjectDetail, statuses: { key: string; label: string }[], facts: Facts, form: FormContext, name: string): Html {
  const { shown, long } = factPairs(facts.keys, project, facts.labels, facts.tz);
  const notes = project.notes !== null && project.notes !== "" ? project.notes : null;
  return html`<div data-region="project-facts"><div class="project-facts">
${shown.length === 0 ? "" : html`<dl class="fact-grid">${shown.map((fact) => html`<div><dt>${fact.name}</dt><dd>${fact.value}</dd></div>`)}</dl>`}
${project.archived ? html`<p class="note">This project is archived.</p>` : ""}
${project.time?.running === true ? html`<p class="note">A timer is running.</p>` : ""}
<div class="fact-actions">
${statusForm(project.id, statuses, form, project.status)}
${project.archived ? "" : startTimerForm({ kind: "project", id: project.id }, form, name)}
<a href="${PROJECT_FACTS_PATH}">Choose facts</a>
</div>
${
  notes === null && long.length === 0
    ? ""
    : html`<details class="project-notes">
<summary>Notes</summary>
${notes === null ? "" : html`<p class="project-notes-text">${notes}</p>`}
${pairs(long)}
</details>`
}
</div></div>`;
}

async function tasksRegion(project: ProjectDetail, now: Date, tz: string, form: FormContext, subject: Subject): Promise<Html> {
  const { open, truncated, counts } = project.taskTree;
  return html`<div data-region="project-tasks">${addTaskLine(subject, form)}
<section aria-labelledby="tasks-heading">
<div class="section-head">
<h2 id="tasks-heading">Open tasks</h2>
${counts.total === 0 ? "" : html`<p class="task-count">${counts.done} of ${counts.total} done</p>`}
</div>
${open.length === 0 ? empty("No open tasks.") : await taskList(open, 1, now, tz, form)}
${truncated ? html`<p class="section-note">Showing the first ${TREE_TASK_LIMIT} tasks.</p>` : ""}
</section></div>`;
}

async function doneRegion(project: ProjectDetail, now: Date, tz: string, form: FormContext): Promise<Html> {
  const { done } = project.taskTree;
  return html`<div data-region="project-done"><details class="done-details" id="done-list"><summary>Done</summary>
${
  done.length === 0
    ? empty("Nothing done yet.")
    : html`<p class="section-note">The latest ${done.length}, newest first.</p>
${await taskList(done, 1, now, tz, form)}`
}
</details></div>`;
}

function notesSection(project: ProjectDetail, form: FormContext, subject: Subject): Html {
  return section(
    "timeline-heading",
    "Notes",
    html`${logForm(subject, form)}
${
      project.timeline.length === 0
        ? empty("Nothing logged yet.", "Calls and notes you log here or through your AI app show up here.")
        : html`<p class="section-note">Newest first.</p>
<ol class="panel rows timeline">${project.timeline.map((item) => timelineItem(item))}</ol>`
    }`,
  );
}

const outsideIn = (nodes: TaskNode[]): boolean => nodes.some((node) => node.untrusted_fields.length > 0 || outsideIn(node.children));

function hasOutsideText(project: ProjectDetail): boolean {
  return (
    project.untrusted_fields.length > 0 ||
    outsideIn(project.taskTree.open) ||
    outsideIn(project.taskTree.done) ||
    project.timeline.some((item) => item.untrusted_text !== null || item.untrusted_fields.length > 0)
  );
}

/** The project page, or null when there is none with this id or projects are off (the caller answers with the 404 page). */
export async function projectPage(ctx: PageContext, id: string): Promise<string | null> {
  if (ctx.projects !== true) return null;
  const { db, now } = ctx;
  let project: ProjectDetail;
  try {
    project = await getProject(db, id, now);
  } catch (error) {
    if (error instanceof UserError) return null;
    throw error;
  }
  // A name is looked up by id only here: a project another one is named like never gets this page.
  if (project.id !== id) return null;
  const tz = await ownerTimezone(db);
  const statuses = await statusChoices(db, project.status);
  const defs = await listFieldDefs(db, { entity: "project", includeArchived: true });
  const labels = new Map(defs.map((def) => [def.key, def.label]));
  const live = defs.filter((def) => def.archived === 0).map((def) => def.key);
  const keys = projectFacts(await getSettings(db), live, project.time !== null);
  const nameOutside = project.untrusted_fields.includes("name");
  const name = nameOutside ? `Project ${project.id}` : project.name;
  const subject: Subject = { kind: "project", id: project.id };
  return renderPage({
    title: name,
    description: "The project's status, time, open and done tasks and notes.",
    current: "/projects",
    frame: ctx,
    body: html`<p class="back"><a href="/projects">Back to projects</a></p>
${headRow(project, ctx)}
${hasOutsideText(project) ? outsideNote() : ""}
${factsBlock(project, statuses, { keys, labels, tz }, ctx, name)}
${await tasksRegion(project, now, tz, ctx, subject)}
${await doneRegion(project, now, tz, ctx)}
${notesSection(project, ctx, subject)}`,
  });
}
