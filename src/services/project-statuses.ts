// Project statuses (migrations 0020, 0021): the owner adds, renames, reorders, switches open or closed, and archives
// them by talking. A status's key is the slug of its first label and never changes. Configuration, so each call
// writes at once as one audited change that undo reverses. Positions are renumbered 1..n inside the change that moves
// a status: live ones first, archived ones after.
import type { Db, ProjectStatusRow } from "../db/db.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, StaleWriteError, updatedRow, withGuardReason } from "./change.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { projectStatusRows, type Reader } from "./memo.ts";
import { requireProjects } from "./settings.ts";
import { slugOf, uniqueKey } from "./slug.ts";

const MAX_LABEL = 60;

type Kind = ProjectStatusRow["kind"];

export interface ProjectStatusInput {
  label: string;
  /** Defaults to "open". */
  kind?: Kind;
  /** 1-based place among the live statuses; last by default. */
  position?: number;
}

export interface ProjectStatusPatch {
  label?: string;
  kind?: Kind;
  /** 1-based place among the live statuses. */
  position?: number;
}

/** Each project status key and its label now, archived ones too (a project may still carry one). */
export async function projectStatusLabels(src: Reader): Promise<Map<string, string>> {
  return new Map((await projectStatusRows(src, { includeArchived: true })).map((row) => [row.key, row.label]));
}

/** Whether a project in this status is finished; an unknown key is not. */
export async function isClosedStatus(src: Reader, key: string): Promise<boolean> {
  return (await projectStatusRows(src, { includeArchived: true })).some((row) => row.key === key && row.kind === "closed");
}

/** The status a new project starts in: the first live open one. */
export async function defaultProjectStatus(src: Reader): Promise<ProjectStatusRow> {
  const first = (await projectStatusRows(src)).find((row) => row.kind === "open");
  if (!first) throw new UserError("There is no live open project status. Add one first with add_project_status.");
  return first;
}

/** What a batch that writes project statuses must leave: at least one live open and one live closed status. */
export function missingKind(rows: readonly ProjectStatusRow[]): Kind | null {
  const live = rows.filter((row) => row.archived === 0);
  return (["open", "closed"] as const).find((kind) => !live.some((row) => row.kind === kind)) ?? null;
}

/** A write_guard statement, run after the status writes, that fails the batch if no live open or no live closed status is left. */
export function liveKindsGuard(db: Db): D1PreparedStatement {
  return withGuardReason(
    db
      .prepare(
        "INSERT INTO write_guard (ok) SELECT " +
          "(SELECT COUNT(*) FROM project_statuses WHERE kind = 'open' AND archived = 0) > 0 AND " +
          "(SELECT COUNT(*) FROM project_statuses WHERE kind = 'closed' AND archived = 0) > 0",
      ),
    "projects need a live open and a live closed status",
    [],
  );
}

function cleanLabel(label: string | undefined): string {
  const text = clean(label);
  if (text === null) throw new UserError('A project status needs a label. Say what to call it, for example "Paused".');
  if (text.length > MAX_LABEL) {
    throw new UserError(`A project status label can be at most ${MAX_LABEL} characters (got ${text.length}).`);
  }
  return text;
}

function refuseDuplicate(all: ProjectStatusRow[], label: string, except?: string): void {
  const clash = all.find((row) => row.key !== except && row.label.toLowerCase() === label.toLowerCase());
  if (clash) throw new UserError(`There's already a project status called ${clash.label} (${clash.key}). Pick a different label.`);
}

/** A live status by key, or by label (ignoring case). */
function pick(all: ProjectStatusRow[], ref: string): ProjectStatusRow {
  const text = ref.trim();
  const match = (rows: ProjectStatusRow[]) => rows.find((row) => row.key === text) ?? rows.find((row) => row.label.toLowerCase() === text.toLowerCase());
  const live = all.filter((row) => row.archived === 0);
  const found = match(live);
  if (found) return found;
  const archived = match(all);
  if (archived) throw new UserError(`${archived.label} is archived, so it can't be changed or used.`);
  const list = live.map((row) => `${row.key} (${row.label})`).join(", ");
  throw new UserError(`There's no project status "${text}". Use one of: ${list}.`);
}

function checkPosition(position: number, max: number): void {
  if (!Number.isInteger(position) || position < 1 || position > max) {
    throw new UserError(`The position must be a whole number between 1 and ${max} (got ${position}).`);
  }
}

function lastOfKind(live: ProjectStatusRow[], status: ProjectStatusRow, doing: string): void {
  if (live.filter((row) => row.kind === status.kind).length > 1) return;
  throw new UserError(
    `Can't ${doing}: ${status.label} is the last ${status.kind} status, and projects need one. ` +
      `Add another ${status.kind} status first with add_project_status.`,
  );
}

/** Row changes that give `ordered` positions 1..n; rows already in place are left alone. */
function renumber(ordered: ProjectStatusRow[], now: Date, edited: Map<string, Partial<ProjectStatusRow>> = new Map()): RowChange[] {
  const changes: RowChange[] = [];
  ordered.forEach((row, index) => {
    const patch: Partial<ProjectStatusRow> = { ...edited.get(row.key), position: index + 1 };
    const differs = Object.entries(patch).some(([column, value]) => row[column as keyof ProjectStatusRow] !== value);
    if (differs) changes.push({ table: "project_statuses", id: row.key, before: row, after: updatedRow(row, patch, now) });
  });
  return changes;
}

const withArchivedLast = (live: ProjectStatusRow[], all: ProjectStatusRow[]) => [...live, ...all.filter((row) => row.archived === 1)];

export async function addProjectStatus(ctx: Ctx, input: ProjectStatusInput): Promise<ChangeResult & { key: string }> {
  await requireProjects(ctx);
  const label = cleanLabel(input.label);
  const kind = input.kind ?? "open";
  const all = await projectStatusRows(ctx, { includeArchived: true });
  const live = all.filter((row) => row.archived === 0);
  refuseDuplicate(all, label);
  const index = input.position === undefined ? live.length : input.position - 1;
  if (input.position !== undefined) checkPosition(input.position, live.length + 1);
  const key = uniqueKey(slugOf(label), new Set(all.map((row) => row.key)));
  const now = ctx.now.toISOString();
  const added: ProjectStatusRow = { key, label, kind, archived: 0, position: index + 1, version: 1, created_at: now, updated_at: now };
  const ordered = withArchivedLast([...live.slice(0, index), added, ...live.slice(index)], all);
  const result = await commitChange(ctx, {
    target: { table: "project_statuses", id: key },
    summary: `Added project status "${label}" (key ${key}, ${kind}) at position ${index + 1} of ${live.length + 1}`,
    changes: [{ table: "project_statuses", id: key, before: null, after: added }, ...renumber(ordered, ctx.now)],
    extra: [liveKindsGuard(ctx.db)],
  });
  return { ...result, key };
}

/** Renames, switches open or closed, or moves one live project status; its key never changes. */
export async function updateProjectStatus(ctx: Ctx, ref: string, patch: ProjectStatusPatch): Promise<ChangeResult & { key: string }> {
  await requireProjects(ctx);
  const all = await projectStatusRows(ctx, { includeArchived: true });
  const live = all.filter((row) => row.archived === 0);
  const status = pick(all, ref);
  const edited: Partial<ProjectStatusRow> = {};
  const parts: string[] = [];

  let renamed = false;
  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label);
    refuseDuplicate(all, label, status.key);
    if (label === status.label) throw new UserError(`Nothing to change: ${status.label} is already called that.`);
    edited.label = label;
    renamed = true;
  }
  if (patch.kind !== undefined && patch.kind !== status.kind) {
    lastOfKind(live, status, `make ${status.label} ${patch.kind}`);
    edited.kind = patch.kind;
    parts.push(`now ${patch.kind}`);
  }
  let ordered = live;
  if (patch.position !== undefined) {
    checkPosition(patch.position, live.length);
    if (live.indexOf(status) !== patch.position - 1) {
      ordered = live.filter((row) => row.key !== status.key);
      ordered.splice(patch.position - 1, 0, status);
      parts.push(`moved to position ${patch.position} of ${live.length}`);
    }
  }
  const changes = renumber(withArchivedLast(ordered, all), ctx.now, new Map([[status.key, edited]]));
  if (changes.length === 0) {
    throw new UserError(`Nothing to change on ${status.label}: give a new label, a kind or a different position.`);
  }
  const rest = parts.join(", ");
  const summary = renamed
    ? `Renamed project status "${status.label}" to "${edited.label}"${rest === "" ? "" : `; ${rest}`}`
    : `Updated project status "${status.label}": ${rest}`;
  const result = await commitChange(ctx, { target: { table: "project_statuses", id: status.key }, summary, changes, extra: [liveKindsGuard(ctx.db)] });
  return { ...result, key: status.key };
}

/** Archives one live status; refused for the last of its kind and while an unarchived project has it. */
export async function archiveProjectStatus(ctx: Ctx, ref: string): Promise<ChangeResult & { key: string }> {
  await requireProjects(ctx);
  const all = await projectStatusRows(ctx, { includeArchived: true });
  const text = ref.trim().toLowerCase();
  const gone = all.find((row) => row.archived === 1 && (row.key === ref.trim() || row.label.toLowerCase() === text));
  if (gone) throw new UserError(`${gone.label} is already archived. Nothing to do.`);
  const status = pick(all, ref);
  const live = all.filter((row) => row.archived === 0);
  lastOfKind(live, status, `archive ${status.label}`);
  await refuseWhileInUse(ctx, status);
  const stay = live.filter((row) => row.key !== status.key);
  const ordered = [...stay, ...all.filter((row) => row.archived === 1), status];
  const edited = new Map([[status.key, { archived: 1 as const }]]);
  try {
    const result = await commitChange(ctx, {
      target: { table: "project_statuses", id: status.key },
      summary: `Archived project status ${status.label}`,
      changes: renumber(ordered, ctx.now, edited),
      extra: [noProjectHas(ctx.db, status.key), liveKindsGuard(ctx.db)],
    });
    return { ...result, key: status.key };
  } catch (error) {
    // The guard that tripped may be the in-use one (a project moved here since the read): then say so.
    if (error instanceof StaleWriteError) await refuseWhileInUse(ctx, status);
    throw error;
  }
}

/** A write_guard statement that fails the batch while an unarchived project has the status. */
function noProjectHas(db: Db, key: string): D1PreparedStatement {
  return withGuardReason(
    db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 0 FROM projects WHERE status_key = ? AND archived = 0").bind(key),
    "a project status in use can't be archived",
    [key],
  );
}

async function refuseWhileInUse(ctx: Ctx, status: ProjectStatusRow): Promise<void> {
  const n = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status_key = ? AND archived = 0").bind(status.key).first<number>("n")) ?? 0;
  if (n === 0) return;
  const one = n === 1;
  throw new UserError(
    `${n} project${one ? " has" : "s have"} ${status.label}. Move ${one ? "it" : "them"} first with update_project, then archive the status.`,
  );
}
