// Project statuses (migration 0020): three fixed ones (active, on_hold, done) whose labels the owner can rename.
// Configuration, so it writes at once as one audited change that undo reverses.
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "./change.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { projectStatusRows, type Reader } from "./memo.ts";
import { requireProjects } from "./settings.ts";

const MAX_LABEL = 60;

/** Each project status key and its label now. */
export async function projectStatusLabels(src: Reader): Promise<Map<string, string>> {
  return new Map((await projectStatusRows(src)).map((row) => [row.key, row.label]));
}

/** Renames one project status; its key never changes. */
export async function updateProjectStatus(ctx: Ctx, key: string, label: string): Promise<ChangeResult> {
  await requireProjects(ctx);
  const all = await projectStatusRows(ctx);
  const ref = key.trim();
  const status = all.find((row) => row.key === ref);
  if (!status) {
    const list = all.map((row) => `${row.key} (${row.label})`).join(", ");
    throw new UserError(`There's no project status "${ref}". Use one of: ${list}.`);
  }
  const text = clean(label);
  if (text === null) throw new UserError('A project status needs a label. Say what to call it, for example "Paused".');
  if (text.length > MAX_LABEL) {
    throw new UserError(`A project status label can be at most ${MAX_LABEL} characters (got ${text.length}).`);
  }
  const clash = all.find((row) => row.key !== status.key && row.label.toLowerCase() === text.toLowerCase());
  if (clash) throw new UserError(`There's already a project status called ${clash.label} (${clash.key}). Pick a different label.`);
  if (text === status.label) throw new UserError(`Nothing to change: ${status.label} is already called that.`);
  return commitChange(ctx, {
    target: { table: "project_statuses", id: status.key },
    summary: `Renamed project status "${status.label}" to "${text}"`,
    changes: [{ table: "project_statuses", id: status.key, before: status, after: updatedRow(status, { label: text }, ctx.now) }],
  });
}
