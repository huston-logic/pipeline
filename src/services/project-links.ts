// The link rules for a project (decision 0055): who a project's records belong to, in one place. A record on a project
// (task, note, time entry, timer) gets the project's person and no deal.
import type { ContactRow, ProjectRow } from "../db/db.ts";
import { UserError } from "./errors.ts";
import { contactName, projectTitle } from "./labels.ts";
import { contactById, findSubject, type Source } from "./lookup.ts";
import { findProject } from "./projects.ts";

/** A live project and its person. An archived project takes nothing new. */
export async function projectLinks(src: Source, ref: string): Promise<{ project: ProjectRow; contact: ContactRow }> {
  const project = await findProject(src, ref);
  if (project.archived === 1) {
    throw new UserError(`Project ${projectTitle(project)} is archived. Bring it back first (update_project archived false).`);
  }
  const contact = await contactById(src, project.contact_id);
  if (!contact) throw new Error(`Project ${project.id} points at a missing contact.`);
  return { project, contact };
}

/**
 * A project given with the other ways to say who a record is for (a deal or a person ref), checked against the link
 * rules: a deal is refused, and so is any person but the project's. Refuses while projects are off.
 */
export async function projectSubject(
  src: Source,
  ref: string,
  given: { dealId?: string | null; contactId?: string | null },
): Promise<{ project: ProjectRow; contact: ContactRow }> {
  const links = await projectLinks(src, ref);
  await checkGiven(src, links, given);
  return links;
}

/** Checks the deal and person ref a record was given beside a project (already found) against the link rules. */
export async function checkGiven(
  src: Source,
  { project, contact }: { project: ProjectRow; contact: ContactRow },
  given: { dealId?: string | null; contactId?: string | null },
): Promise<void> {
  const deal = typeof given.dealId === "string" && given.dealId.trim() !== "";
  const named = !deal && typeof given.contactId === "string" ? (await findSubject(src, { contactId: given.contactId }, { optional: true })).contact : null;
  checkOnProject(project, contact, { deal, contact: named });
}

/** What else a record on a project was given: a deal, or a person. Refuses a deal, or a person other than the project's. */
export function checkOnProject(project: ProjectRow, owner: ContactRow, given: { deal: boolean; contact: ContactRow | null }): void {
  if (given.deal) throw new UserError("Give the project or the deal, not both.");
  if (given.contact && given.contact.id !== owner.id) {
    throw new UserError(
      `${projectTitle(project)} belongs to ${contactName(owner)}, not ${contactName(given.contact)}. ` +
        "Give just the project, or the project's own person.",
    );
  }
}
