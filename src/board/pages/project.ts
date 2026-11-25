// /projects/<pj id> (decision 0055): the project's card, its time (only while time tracking is on), open and done tasks,
// and its notes. 404 while projects are off, for an unknown id or one that is no project's. A name from outside is
// labelled and never in the <title>, the description or a link's text.
import { listFieldDefs } from "../../db/queries.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { getProject, type ProjectDetail, type TaskNode, TREE_TASK_LIMIT } from "../../services/project-read.ts";
import { UserError } from "../../services/errors.ts";
import { formatDuration, formatMoney } from "../../services/time-format.ts";
import type { PageContext } from "../context.ts";
import { type FormContext, hidden, postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { logForm } from "../log-form.ts";
import { contactLink, dealLink, empty, labelled, pairs, projectHref, section, tag } from "../parts.ts";
import { statusChoices } from "../project-form.ts";
import { taskList } from "../project-tree.ts";
import { customRows, outsideNote, timelineItem } from "../records.ts";
import { addTaskForm, type Subject } from "../task-forms.ts";
import { startTimerForm } from "../timer-start.ts";
import { dateOr } from "../project-parts.ts";

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

function projectSection(project: ProjectDetail, statuses: { key: string; label: string }[], labels: Map<string, string>, tz: string, form: FormContext): Html {
  const outside = new Set<string>(project.untrusted_fields);
  return section(
    "project-heading",
    "Project",
    html`<div class="card">
${pairs([
  { name: "Status", value: project.statusLabel },
  { name: "Person", value: project.contactId === null || project.contactName === null ? "Internal" : contactLink(project.contactId, project.contactName, outside.has("contactName")) },
  project.dealId !== null && project.dealTitle !== null && { name: "From deal", value: dealLink(project.dealId, project.dealTitle, outside.has("dealTitle")) },
  { name: "Start", value: dateOr(project.startAt, tz) },
  { name: "Target", value: dateOr(project.targetAt, tz) },
  project.notes !== null && project.notes !== "" && { name: "Notes", value: project.notes },
  ...customRows(project.fields, labels, new Set()),
])}
${project.archived ? html`<p class="note">This project is archived.</p>` : ""}
<p class="card-actions"><a href="${projectEditPath(project.id)}">Edit project</a></p>
${statusForm(project.id, statuses, form, project.status)}
${archiveForm(project, form)}
</div>`,
  );
}

function timeSection(project: ProjectDetail, form: FormContext, name: string): Html | "" {
  const { time } = project;
  if (time === null) return "";
  return section(
    "time-heading",
    "Time",
    html`<div class="card">
${pairs([
  { name: "Total", value: formatDuration(time.minutes) },
  { name: "Billable", value: formatDuration(time.billableMinutes) },
  { name: "Not billable", value: formatDuration(time.nonBillableMinutes) },
  { name: "Amount", value: formatMoney(time.amountCents / 100) },
])}
${time.running ? html`<p class="note">A timer is running.</p>` : ""}
${project.archived ? "" : startTimerForm({ kind: "project", id: project.id }, form, name)}
<p class="card-actions"><a href="/time">See time</a></p>
</div>`,
  );
}

function tasksSection(project: ProjectDetail, now: Date, tz: string, form: FormContext, subject: Subject): Html {
  const { open, truncated } = project.taskTree;
  return section(
    "tasks-heading",
    "Open tasks",
    html`${open.length === 0 ? empty("No open tasks.") : taskList(open, 1, now, tz, form)}
${truncated ? html`<p class="section-note">Showing the first ${TREE_TASK_LIMIT} tasks.</p>` : ""}
${addTaskForm(subject, form)}`,
  );
}

function doneSection(project: ProjectDetail, now: Date, tz: string, form: FormContext): Html {
  const { done } = project.taskTree;
  return section(
    "done-heading",
    "Done",
    done.length === 0
      ? empty("Nothing done yet.")
      : html`<p class="section-note">The latest ${done.length}, newest first.</p>
${taskList(done, 1, now, tz, form)}`,
  );
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
  const nameOutside = project.untrusted_fields.includes("name");
  const name = nameOutside ? `Project ${project.id}` : project.name;
  const subject: Subject = { kind: "project", id: project.id };
  return renderPage({
    title: name,
    description: "The project's status, time, open and done tasks and notes.",
    current: "/projects",
    frame: ctx,
    body: html`<p class="back"><a href="/projects">Back to projects</a></p>
<h1>${labelled(project.name, nameOutside)}</h1>
<p class="lede deal-status">${tag(project.archived ? `${project.statusLabel}, archived` : project.statusLabel)}</p>
${hasOutsideText(project) ? outsideNote() : ""}
<div class="deal-columns">
<div>
${projectSection(project, statuses, labels, tz, ctx)}
${timeSection(project, ctx, name)}
</div>
<div>
${tasksSection(project, now, tz, ctx, subject)}
${doneSection(project, now, tz, ctx)}
${notesSection(project, ctx, subject)}
</div>
</div>`,
  });
}
