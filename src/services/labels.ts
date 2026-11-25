// Safe labels: how a summary, an undo message or an error names a record. A value the owner or the AI gave is shown;
// a value that came from outside (listed in the row's untrusted_fields, or an activity not written by the owner or
// the AI) becomes an id label such as "contact ct_…". So change summaries, tool headlines and error messages never
// carry outside text (decisions 0004 and 0009). Import-free apart from types.
import type { Actor } from "../db/db.ts";

type WithProvenance = { untrusted_fields?: unknown };

/** The row's untrusted_fields as a set. Missing (a row from before migration 0002) or unreadable means none. */
export function untrustedFields(row: WithProvenance): Set<string> {
  if (typeof row.untrusted_fields !== "string") return new Set();
  try {
    const value: unknown = JSON.parse(row.untrusted_fields);
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export const isTrusted = (row: WithProvenance, field: string) => !untrustedFields(row).has(field);

type ContactLike = WithProvenance & { id: string; name: string; email?: string | null };
type TitledLike = WithProvenance & { id: string; title: string };
type ActivityLike = { id: string; summary: string; actor: Actor | string };

/** "Pat Example", or "contact ct_…" when the name came from outside. */
export const contactName = (contact: ContactLike) =>
  isTrusted(contact, "name") ? contact.name : `contact ${contact.id}`;

/** For lists of matches: "Pat Example (ct_…, pat@example.com)", or "contact ct_…". */
export function contactRef(contact: ContactLike): string {
  if (!isTrusted(contact, "name")) return `contact ${contact.id}`;
  const email = contact.email && isTrusted(contact, "email") ? `, ${contact.email}` : "";
  return `${contact.name} (${contact.id}${email})`;
}

/** "\"Website refresh\"", or "deal dl_…" when the title came from outside. */
export const dealTitle = (deal: TitledLike) => (isTrusted(deal, "title") ? `"${deal.title}"` : `deal ${deal.id}`);

/** "\"Website refresh\" (Pat Example)", with each part safe on its own. */
export const dealLabel = (deal: TitledLike, contact: ContactLike) => `${dealTitle(deal)} (${contactName(contact)})`;

/** "\"Website refresh\"", or "project pj_…" when the name came from outside. */
export const projectTitle = (project: WithProvenance & { id: string; name: string }) =>
  isTrusted(project, "name") ? `"${project.name}"` : `project ${project.id}`;

/** "\"Website refresh\" (Pat Example)", with each part safe on its own. */
export const projectLabel = (project: WithProvenance & { id: string; name: string }, contact: ContactLike) =>
  `${projectTitle(project)} (${contactName(contact)})`;

/** "\"Call back\"", or "task tk_…" when the title came from outside. */
export const taskTitle = (task: TitledLike) => (isTrusted(task, "title") ? `"${task.title}"` : `task ${task.id}`);

/** An activity's summary when the owner or the AI wrote it, otherwise "activity ac_…". */
export const activityText = (activity: ActivityLike) =>
  activity.actor === "owner" || activity.actor === "ai" ? activity.summary : `activity ${activity.id}`;

/** How a summary names a push subscription: by id only, never by its endpoint (decision 0030). */
export const pushLabel = (id: string) => `notifications on one device (${id})`;

/** A campaign by id only: its name may be written by the AI, so no summary or error carries it. */
export const campaignLabel = (id: string) => `campaign ${id}`;

/** The row's untrusted_fields without `fields`: what is left once the owner or the AI has set them. */
export function withoutUntrusted(row: WithProvenance, fields: string[]): string {
  return JSON.stringify([...untrustedFields(row)].filter((field) => !fields.includes(field)));
}
