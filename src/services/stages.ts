// add_stage, update_stage and archive_stage. A stage's key is the slug of its first label and never changes, so
// renaming a stage leaves its deals, rules and history pointing at it. Positions are always renumbered 1..n inside the
// change that moves a stage: active stages first, archived ones after them.
import type { Db, StageKind, StageRow } from "../db/db.ts";
import { listStages } from "../db/queries.ts";
import { type ChangeResult, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { joinAnd } from "./describe.ts";
import { UserError } from "./errors.ts";
import { clean } from "./input.ts";
import { dealLabel } from "./labels.ts";
import { slugOf, uniqueKey } from "./slug.ts";

const MAX_LABEL = 60;
const SHOWN_DEALS = 5;

const KIND_WORDS: Record<StageKind, string> = { open: "open", won: "won", lost: "lost", not_now: "not now" };

export interface StageInput {
  label: string;
  /** Defaults to "open". */
  kind?: StageKind;
  /** Key or label of the stage this one goes after. Default: after the last open stage (others go last). */
  after?: string;
}

export interface StagePatch {
  label?: string;
  /** 1-based place among the stages that are not archived. */
  position?: number;
}

function cleanLabel(label: string | undefined): string {
  const text = clean(label);
  if (text === null) throw new UserError("A stage needs a label. Say what to call it, for example \"Demo booked\".");
  if (text.length > MAX_LABEL) throw new UserError(`A stage label can be at most ${MAX_LABEL} characters (got ${text.length}).`);
  return text;
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function refuseDuplicateLabel(active: StageRow[], label: string, except?: string): void {
  const clash = active.find((s) => s.key !== except && sameLabel(s.label, label));
  if (clash) {
    throw new UserError(`There's already a stage called ${clash.label} (${clash.key}). Pick a different label.`);
  }
}

/** A stage by key or by label (ignoring case), from the list given. */
function pick(stages: StageRow[], ref: string): StageRow {
  const text = ref.trim();
  const match = stages.find((s) => s.key === text) ?? stages.find((s) => sameLabel(s.label, text));
  if (match) return match;
  const list = stages.map((s) => `${s.label} (${s.key})`).join(", ");
  throw new UserError(`There's no stage "${text}". Stages: ${list}. Use one of those.`);
}

/** Row changes that give `ordered` positions 1..n; stages already in place are left alone. */
function renumber(ordered: StageRow[], now: Date, edited: Map<string, Partial<StageRow>> = new Map()): RowChange[] {
  const changes: RowChange[] = [];
  ordered.forEach((row, index) => {
    const patch: Partial<StageRow> = { ...edited.get(row.key), position: index + 1 };
    const after = updatedRow(row, patch, now);
    const differs = Object.entries(patch).some(([column, value]) => row[column as keyof StageRow] !== value);
    if (differs) changes.push({ table: "stages", id: row.key, before: row, after });
  });
  return changes;
}

const withArchivedLast = (active: StageRow[], all: StageRow[]) => [...active, ...all.filter((s) => s.archived === 1)];

export async function addStage(ctx: Ctx, input: StageInput): Promise<ChangeResult & { key: string }> {
  const { db } = ctx;
  const label = cleanLabel(input.label);
  const kind = input.kind ?? "open";
  const all = await listStages(db, { includeArchived: true });
  const active = all.filter((s) => s.archived === 0);
  refuseDuplicateLabel(active, label);
  const key = uniqueKey(slugOf(label), new Set(all.map((s) => s.key)));

  let index: number;
  if (input.after !== undefined && clean(input.after) !== null) {
    index = active.indexOf(pick(active, input.after)) + 1;
  } else if (kind === "open") {
    index = active.findLastIndex((s) => s.kind === "open") + 1;
  } else {
    index = active.length;
  }

  const now = ctx.now.toISOString();
  const added: StageRow = { key, label, position: index + 1, kind, archived: 0, version: 1, created_at: now, updated_at: now };
  const ordered = withArchivedLast([...active.slice(0, index), added, ...active.slice(index)], all);
  const result = await commitChange(ctx, {
    target: { table: "stages", id: key },
    summary: `Added stage ${label} (key ${key}) ${index === 0 ? "as the first stage" : `after ${ordered[index - 1]?.label ?? ""}`}`,
    // The new stage is already in its place, so renumber() leaves it out and moves only the others.
    changes: [{ table: "stages", id: key, before: null, after: added }, ...renumber(ordered, ctx.now)],
  });
  return { ...result, key };
}

export async function updateStage(ctx: Ctx, ref: string, patch: StagePatch): Promise<ChangeResult & { key: string }> {
  const { db } = ctx;
  const all = await listStages(db, { includeArchived: true });
  const active = all.filter((s) => s.archived === 0);
  const stage = pick(active, ref);

  const edited = new Map<string, Partial<StageRow>>();
  const parts: string[] = [];
  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label);
    refuseDuplicateLabel(active, label, stage.key);
    if (label !== stage.label) {
      edited.set(stage.key, { label });
      parts.push(`Renamed stage ${stage.label} to ${label}`);
    }
  }
  let ordered = active;
  if (patch.position !== undefined) {
    if (!Number.isInteger(patch.position) || patch.position < 1 || patch.position > active.length) {
      throw new UserError(`The position must be a whole number between 1 and ${active.length} (got ${patch.position}).`);
    }
    const from = active.indexOf(stage);
    if (from !== patch.position - 1) {
      ordered = active.filter((s) => s.key !== stage.key);
      ordered.splice(patch.position - 1, 0, stage);
      const name = edited.get(stage.key)?.label ?? stage.label;
      parts.push(`${parts.length > 0 ? "moved it" : `Moved stage ${name}`} to position ${patch.position} of ${active.length}`);
    }
  }
  const changes = renumber(withArchivedLast(ordered, all), ctx.now, edited);
  if (changes.length === 0) {
    throw new UserError(`Nothing to change on ${stage.label}: give a new label or a different position.`);
  }
  const result = await commitChange(ctx, {
    target: { table: "stages", id: stage.key },
    summary: parts.join("; "),
    changes,
  });
  return { ...result, key: stage.key };
}

type OpenDeal = { id: string; title: string; untrusted_fields: string; contact_id: string; contact: string; contact_untrusted: string };

async function openDealsIn(db: Db, key: string): Promise<OpenDeal[]> {
  const found = await db
    .prepare(
      `SELECT d.id, d.title, d.untrusted_fields, c.id AS contact_id, c.name AS contact,
         c.untrusted_fields AS contact_untrusted
       FROM deals d JOIN contacts c ON c.id = d.contact_id
       WHERE d.stage_key = ? AND d.status = 'open' AND d.archived = 0 ORDER BY d.stage_entered_at, d.id`,
    )
    .bind(key)
    .all<OpenDeal>();
  return found.results;
}

export async function archiveStage(ctx: Ctx, ref: string): Promise<ChangeResult & { key: string }> {
  const { db } = ctx;
  const all = await listStages(db, { includeArchived: true });
  const text = ref.trim();
  const found = all.find((s) => s.key === text) ?? all.find((s) => s.archived === 0 && sameLabel(s.label, text));
  const stage = found ?? pick(all.filter((s) => s.archived === 0), ref);
  if (stage.archived === 1) throw new UserError(`${stage.label} is already archived. Nothing to do.`);

  const active = all.filter((s) => s.archived === 0);
  const same = active.filter((s) => s.kind === stage.kind);
  if (same.length === 1) {
    const why = stage.kind === "open" ? "new leads need one" : "deals need one to close into";
    throw new UserError(
      `Can't archive ${stage.label}: it's the last ${KIND_WORDS[stage.kind]} stage, and ${why}. ` +
        `Add another ${KIND_WORDS[stage.kind]} stage first with add_stage.`,
    );
  }

  const deals = await openDealsIn(db, stage.key);
  if (deals.length > 0) {
    const open = active.filter((s) => s.kind === "open" && s.key !== stage.key);
    const index = active.indexOf(stage);
    const target = open.findLast((s) => active.indexOf(s) < index) ?? open[0];
    const shown = deals
      .slice(0, SHOWN_DEALS)
      .map((d) =>
        dealLabel(d, { id: d.contact_id, name: d.contact, untrusted_fields: d.contact_untrusted }),
      );
    const more = deals.length > SHOWN_DEALS ? ` and ${deals.length - SHOWN_DEALS} more` : "";
    const list = deals.length > SHOWN_DEALS ? `${shown.join(", ")}${more}` : joinAnd(shown);
    const one = deals.length === 1;
    throw new UserError(
      `${deals.length} open deal${one ? " is" : "s are"} in ${stage.label}: ${list}. ` +
        `Move ${one ? "it" : "them"} first with update_deal${target ? `, for example to ${target.label}` : ""}.`,
    );
  }

  const after = updatedRow(stage, { archived: 1 }, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "stages", id: stage.key },
    summary: `Archived stage ${stage.label}`,
    changes: [{ table: "stages", id: stage.key, before: stage, after }],
  });
  return { ...result, key: stage.key };
}

export interface StageOverview {
  key: string;
  label: string;
  position: number;
  kind: StageKind;
  archived: boolean;
  openDeals: number;
}

/** list_stages: every stage in board order with how many open deals sit in it. */
export async function stageOverview(db: Db, includeArchived: boolean): Promise<StageOverview[]> {
  const counts = await db
    .prepare("SELECT stage_key, COUNT(*) AS n FROM deals WHERE status = 'open' AND archived = 0 GROUP BY stage_key")
    .all<{ stage_key: string; n: number }>();
  return (await listStages(db, { includeArchived })).map((s) => ({
    key: s.key,
    label: s.label,
    position: s.position,
    kind: s.kind,
    archived: s.archived === 1,
    openDeals: counts.results.find((c) => c.stage_key === s.key)?.n ?? 0,
  }));
}
