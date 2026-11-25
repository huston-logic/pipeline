// How a project reads in a list, on a card or in a table cell: shared by /projects and a saved projects view. A name from
// outside is never a link's text; a project with no person says "Internal".
import type { ProjectItem } from "../services/project-read.ts";
import { formatLocal } from "../time.ts";
import { type Html, html } from "./html.ts";
import { contactLink, pairs, projectLink, tag, when } from "./parts.ts";

export const itemLink = (project: ProjectItem): Html => projectLink(project.id, project.name, project.untrusted_fields.includes("name"));

/** A stored midnight as the day only: "Sat Dec 5". */
export const dateOr = (iso: string | null, tz: string): Html | string =>
  iso === null ? "Not set" : when(iso, formatLocal(iso, tz).replace(/,\s\d{1,2}:\d{2}\s[AP]M$/, ""));

export const statusText = (project: ProjectItem): string => (project.archived ? `${project.statusLabel}, archived` : project.statusLabel);

export const personOf = (project: ProjectItem): Html | string =>
  project.contactId === null || project.contactName === null
    ? "Internal"
    : contactLink(project.contactId, project.contactName, project.untrusted_fields.includes("contactName"));

export function projectCard(project: ProjectItem, tz: string): Html {
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${itemLink(project)}</h2>
${tag(statusText(project))}
</div>
${pairs([
  { name: "Person", value: personOf(project) },
  { name: "Target", value: dateOr(project.targetAt, tz) },
  { name: "Open tasks", value: String(project.openTasks) },
])}
</li>`;
}
