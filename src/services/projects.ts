// add_project and update_project (decision 0055). A project is delivery work after a sale: a person, an optional won
// deal it came from, a status, dates and notes. Making one never changes its deal; the deal's open tasks move only
// when asked (moveOpenTasks), in the same change.
import type { ContactRow, ProjectRow, ProjectStatusRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { formatLocal } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { capitalize } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean, whenOrNull } from "./input.ts";
import { contactName, dealLabel, dealTitle, isTrusted, projectLabel, projectTitle } from "./labels.ts";
import { contactById, findSubject, openTasksOfDeal, ownerTimezone, projectById, type Source, sourceOf } from "./lookup.ts";
import { projectStatusRows } from "./memo.ts";
import { requireProjects } from "./settings.ts";

export interface ProjectInput {
  /** At most 200 characters on one line; defaults to the deal's title when that is the owner's. */
  name?: string;
  /** Contact id or exact name. */
  contact?: string;
  /** A won deal's id, title or contact name. */
  deal?: string;
  /** A status key or label; Active when left out. */
  status?: string;
  startAt?: string;
  targetAt?: string;
  notes?: string;
  /** Moves every open task of the deal onto the project; needs a deal. */
  moveOpenTasks?: boolean;
}

export interface ProjectPatch {
  name?: string;
  status?: string;
  startAt?: string | null;
  targetAt?: string | null;
  notes?: string | null;
  archived?: boolean;
}

const NAME_HELP = "Name the project in a few words.";

function checkName(raw: string | null | undefined): string {
  const name = clean(raw);
  if (name === null) throw new UserError(NAME_HELP);
  if (/[\r\n]/.test(name)) throw new UserError("A project name has to be on one line. Shorten it to a few words.");
  if (name.length > 200) throw new UserError(`A project name is at most 200 characters (this one is ${name.length}). Shorten it.`);
  return name;
}

/** A project status by key or label (ignoring case). */
async function findProjectStatus(src: Source, ref: string): Promise<ProjectStatusRow> {
  const text = ref.trim();
  const statuses = await projectStatusRows(src);
  const match = statuses.find((s) => s.key === text) ?? statuses.find((s) => s.label.toLowerCase() === text.toLowerCase());
  if (match) return match;
  throw new UserError(`There is no status "${text}". Statuses: ${statuses.map((s) => s.label).join(", ")}. Use one of those.`);
}

const projectRef = (project: ProjectRow) => (isTrusted(project, "name") ? `"${project.name}" (${project.id})` : `project ${project.id}`);

/** A project by id, or by exact name (ignoring case) among the live ones. Refuses while projects are off. */
export async function findProject(src: Source, ref: string): Promise<ProjectRow> {
  await requireProjects(src);
  const text = ref.trim();
  if (text === "") throw new UserError("Say which project: give its id (pj_...) or its exact name.");
  const byId = await projectById(src, text);
  if (byId) return byId;
  const { db } = sourceOf(src);
  const matches = (
    await db.prepare("SELECT * FROM projects WHERE lower(name) = lower(?) AND archived = 0 ORDER BY created_at, id").bind(text).all<ProjectRow>()
  ).results;
  const [only, ...others] = matches;
  if (!only) throw new UserError(`No project matches "${text}". Use list_projects to find the project's id.`);
  if (others.length === 0) return only;
  throw new UserError(`"${text}" matches more than one project: ${matches.map(projectRef).join("; ")}. Use the project id instead.`);
}

/** "Mon Dec 1" for a date kept at local midnight, with the time otherwise. */
const dayText = (iso: string, tz: string) => formatLocal(iso, tz).replace(/, 12:00 AM$/, "");

function checkDates(startAt: string | null, targetAt: string | null): void {
  if (startAt !== null && targetAt !== null && targetAt < startAt) {
    throw new UserError("The target date is before the start date. Give a target on or after the start.");
  }
}

export async function addProject(ctx: Ctx, input: ProjectInput): Promise<ChangeResult & { projectId: string; contactId: string }> {
  await requireProjects(ctx);
  const tz = await ownerTimezone(ctx);
  const { deal, contact } = await findSubject(ctx, { dealId: input.deal, contactId: input.contact }, { optional: true });
  if (contact === null) throw new UserError("A project needs a person: give contact, or a won deal.");
  if (deal && deal.status !== "won") {
    throw new UserError(`A project comes from a won deal. Mark ${dealTitle(deal)} Won first, or leave the deal out.`);
  }
  if (deal && deal.archived === 1) throw new UserError(`${capitalize(dealLabel(deal, contact))} is archived, so a project can't come from it.`);
  if (input.moveOpenTasks === true && !deal) throw new UserError("moveOpenTasks needs a deal: give the won deal whose open tasks should move.");

  const given = clean(input.name);
  const name = checkName(given ?? (deal && isTrusted(deal, "title") ? deal.title : null));
  const status = await findProjectStatus(ctx, input.status ?? "active");
  const startAt = whenOrNull(input.startAt ?? null, tz);
  const targetAt = whenOrNull(input.targetAt ?? null, tz);
  checkDates(startAt, targetAt);

  const now = ctx.now.toISOString();
  const project: ProjectRow = {
    id: newId("pj"),
    name,
    contact_id: contact.id,
    deal_id: deal?.id ?? null,
    status_key: status.key,
    start_at: startAt,
    target_at: targetAt,
    notes: clean(input.notes),
    archived: 0,
    untrusted_fields: "[]",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const changes: RowChange[] = [{ table: "projects", id: project.id, before: null, after: project }];
  const moved = deal && input.moveOpenTasks === true ? await openTasksOfDeal(ctx, deal.id) : [];
  for (const task of moved) {
    const after = updatedRow(task, { project_id: project.id, deal_id: null, contact_id: contact.id }, ctx.now);
    changes.push({ table: "tasks", id: task.id, before: task, after });
  }
  const from = deal ? `, from ${dealTitle(deal)}` : "";
  const movedText = moved.length === 0 ? "" : ` (moved ${moved.length} open task${moved.length === 1 ? "" : "s"})`;
  const result = await commitChange(ctx, {
    target: { table: "projects", id: project.id },
    summary: `Added project ${projectTitle(project)} for ${contactName(contact)}${from}${movedText}`,
    changes,
  });
  return { ...result, projectId: project.id, contactId: contact.id };
}

export async function updateProject(ctx: Ctx, ref: string, patch: ProjectPatch): Promise<ChangeResult & { projectId: string }> {
  const before = await findProject(ctx, ref);
  const contact: ContactRow | null = await contactById(ctx, before.contact_id);
  if (!contact) throw new Error(`Project ${before.id} points at a missing contact.`);
  const tz = await ownerTimezone(ctx);
  const set: Partial<ProjectRow> = {};
  const parts: string[] = [];

  if (patch.name !== undefined) {
    const name = checkName(patch.name);
    if (name !== before.name) {
      set.name = name;
      parts.push(`name "${name}"`);
    }
  }
  if (patch.status !== undefined) {
    const status = await findProjectStatus(ctx, patch.status);
    if (status.key !== before.status_key) {
      const labels = new Map((await projectStatusRows(ctx)).map((s) => [s.key, s.label]));
      set.status_key = status.key;
      parts.push(`status ${labels.get(before.status_key) ?? before.status_key} -> ${status.label}`);
    }
  }
  for (const [field, column, word] of [
    ["startAt", "start_at", "start"],
    ["targetAt", "target_at", "target"],
  ] as const) {
    const given = patch[field];
    if (given === undefined) continue;
    const value = whenOrNull(given, tz);
    if (value === before[column]) continue;
    set[column] = value;
    parts.push(value === null ? `${word} cleared` : `${word} ${dayText(value, tz)}`);
  }
  if (patch.notes !== undefined) {
    const notes = clean(patch.notes);
    if (notes !== before.notes) {
      set.notes = notes;
      parts.push(notes === null ? "notes cleared" : "notes updated");
    }
  }
  if (patch.archived !== undefined && (patch.archived ? 1 : 0) !== before.archived) {
    set.archived = patch.archived ? 1 : 0;
    parts.push(patch.archived ? "archived" : "brought back");
  }
  if (parts.length === 0) {
    throw new UserError(`Nothing to change on ${projectLabel(before, contact)}: those values are already set. Give a different value.`);
  }
  checkDates(set.start_at === undefined ? before.start_at : set.start_at, set.target_at === undefined ? before.target_at : set.target_at);

  const after = updatedRow(before, set, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "projects", id: before.id },
    summary: `Updated project ${projectTitle(before)} (${contactName(contact)}): ${parts.join(", ")}`,
    changes: [{ table: "projects", id: before.id, before, after }],
  });
  return { ...result, projectId: before.id };
}
