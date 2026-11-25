// Proposals (decision 0044): the AI app sends a list of record actions; propose_changes plans them through the ordinary
// services in collect mode (plan.ts), stores the resolved actions and every row the plan would write with the version
// it read, and answers the list the owner is shown. Nothing else is written. apply_changes, after the owner's yes,
// plans the same actions again at apply time, refuses if any row it would write moved since (or a row appeared or
// vanished), and writes the plan as one audited change with one undo, in the batch that marks the proposal applied.
// Proposals are scratch space like import drafts: not audited, not exported, never logged.
import type { Db, ProposalRow } from "../db/db.ts";
import { isProposalId, newId } from "../ids.ts";
import { formatLocal } from "../time.ts";
import { CHUNK_BYTES, sqlBytes } from "./bulk.ts";
import {
  changeBatch,
  type ChangeInput,
  type ChangeResult,
  commitChange,
  type Ctx,
  errorText,
  guardIds,
  guardReason,
  isChangeTable,
  isDuplicateEmailFailure,
  isForeignKeyFailure,
  isGuardFailure,
  isRunningTimerFailure,
  needsBulk,
  primaryKey,
  type Row,
  StaleWriteError,
} from "./change.ts";
import { capitalize, rowLabel, short } from "./describe.ts";
import { UserError } from "./errors.ts";
import { ownerTimezone } from "./lookup.ts";
import { ReadMemo, settingsRow } from "./memo.ts";
import { PlanCollector } from "./plan.ts";
import {
  type ActionResult,
  bindAction,
  checkActions,
  type RecordAction,
  recordActionSchema,
  resolveActions,
  type ResolvedAction,
  runAction,
  withStopTimes,
} from "./proposal-actions.ts";
import { type ProposalList, proposalList, renderProposal, shownList } from "./proposal-text.ts";
import { TASK_PLAN_MAX } from "./task-plan.ts";
import { runningTimerRefusal } from "./timer.ts";
import { wonDealIds } from "./won-offers.ts";

export const PROPOSAL_MAX_ACTIONS = 25;
export const PROPOSAL_MAX_OPEN = 10;
/** Two hours. */
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

/** Applied and dropped proposals stay a day, so a second yes or the old id of a revised list still gets its answer. */
const KEEP_CLOSED_MS = 24 * 60 * 60 * 1000;

const AGAIN = "Propose the changes again and show the owner the new list.";

const TOO_LONG = "This list is too long to keep. Send it as two lists.";

export type ProposeAnswer =
  | { kind: "proposal"; id: string; expiresAt: string; text: string; list: ProposalList; approveIn: "chat" | "board" }
  | { kind: "questions"; questions: string[] };

type Deps = { extraOwnerEmails: string[] };

/** "3:40 PM" in the owner's timezone. */
const timeOf = (at: string, tz: string) => formatLocal(at, tz).split(", ").at(-1) ?? at;

async function getProposal(db: Db, id: string): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>();
}

/** The open, unexpired lists waiting for the owner, newest first (the board's Pending changes page). */
export async function listOpenProposals(db: Db, now: Date): Promise<ProposalRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM proposals WHERE status = 'open' AND expires_at > ? ORDER BY created_at DESC, rowid DESC")
    .bind(now.toISOString())
    .all<ProposalRow>();
  return results;
}

/** How many lists wait for the owner (Today's notice). */
export async function countOpenProposals(db: Db, now: Date): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open' AND expires_at > ?").bind(now.toISOString()).first<number>("n")) ?? 0;
}

/** The owner turns a waiting list down: it is dropped (scratch space, not audited). Anything not open is refused plainly. */
export async function discardProposal(db: Db, id: string, now: Date): Promise<void> {
  const row = isProposalId(id) ? await getProposal(db, id) : null;
  if (row === null) throw new UserError("That list isn't there any more. It may have expired.");
  if (row.status === "applied") throw new UserError("That list was already approved, so it can't be discarded.");
  if (row.status === "dropped" || row.expires_at <= now.toISOString()) throw new UserError("That list was already closed.");
  await db.prepare("UPDATE proposals SET status = 'dropped' WHERE id = ? AND status = 'open'").bind(id).run();
}

/** The actions planned in order with a fresh collector; a service's refusal comes back as "Action N: ...". */
async function planActions(ctx: Ctx, actions: readonly ResolvedAction[], deps: Deps): Promise<PlanCollector> {
  const plan = new PlanCollector();
  const planCtx: Ctx = { ...ctx, plan };
  const added: ActionResult[] = [];
  for (const [i, action] of actions.entries()) {
    plan.startAction(i + 1);
    try {
      added.push(await runAction(planCtx, bindAction(action, added), deps));
    } catch (error) {
      if (error instanceof UserError) throw new UserError(`Action ${i + 1}: ${error.message}`, { cause: error });
      throw error;
    }
  }
  return plan;
}

/**
 * A list that would write a column no item shows (`unshown`, from shownList) would let the owner say yes to a list
 * that changes more than it says: a gap in proposal-text.ts. That is a programming error, so it is a plain Error and
 * nothing is proposed.
 */
export function checkListShows(unshown: readonly string[]): void {
  if (unshown.length > 0) {
    throw new Error("This list would change records it doesn't show. Nothing was proposed.");
  }
}

function checkPlannedTasks(planned: number): void {
  if (planned > TASK_PLAN_MAX) throw new UserError(`A proposal holds at most ${TASK_PLAN_MAX} planned tasks; this one has ${planned}. Split it into two lists.`);
}

/** The proposal a revised list replaces: it must still be open. */
async function replaceable(db: Db, id: string, now: Date): Promise<ProposalRow> {
  const row = isProposalId(id) ? await getProposal(db, id) : null;
  if (row === null) throw new UserError("There's no proposal by that id to replace. Leave out replaces, or give the id of the list the owner answered.");
  if (row.status === "applied") throw new UserError(`${row.id} was already applied, so it can't be replaced. Send the new changes without replaces.`);
  if (row.status === "dropped") throw new UserError(`${row.id} isn't open: it was replaced by ${row.replaced_by ?? "a later list"}. Replace that one instead.`);
  if (row.expires_at <= now.toISOString()) throw new UserError(`${row.id} isn't open: it has expired. Send the new changes without replaces.`);
  return row;
}

/**
 * propose_changes: checks the actions (schema, caps, "@n"), resolves the records they name (any question stops it
 * here, with nothing stored), plans them, and stores the proposal; with `replaces`, the old one is dropped in the same
 * batch. Writes nothing but the proposal.
 */
export async function proposeChanges(caller: Ctx, input: { actions: RecordAction[]; replaces?: string }, deps: Deps): Promise<ProposeAnswer> {
  // One memo for the whole request: every action, the list and any refusal read the settings-like tables once.
  const ctx: Ctx = { ...caller, memo: new ReadMemo(caller.db) };
  const { db, now } = ctx;
  const count = input.actions.length;
  if (count === 0) throw new UserError("Send at least one action.");
  if (count > PROPOSAL_MAX_ACTIONS) {
    throw new UserError(`A proposal holds at most ${PROPOSAL_MAX_ACTIONS} actions; this one has ${count}. Split it into smaller lists.`);
  }
  const checked = checkActions(input.actions);
  const planned = checked.reduce((sum, action) => sum + ("tasks" in action && action.tasks !== undefined ? action.tasks.length : 0), 0);
  checkPlannedTasks(planned);
  const old = input.replaces === undefined ? null : await replaceable(db, input.replaces.trim(), now);
  const { actions, questions } = await resolveActions(ctx, checked);
  if (questions.length > 0) return { kind: "questions", questions };
  // Planned as asked (a stop ends now), kept with that end, so the apply plans the same span.
  const actionsJson = JSON.stringify(withStopTimes(actions, now));
  if (sqlBytes(actionsJson) > CHUNK_BYTES) throw new UserError(TOO_LONG);

  const plan = await planActions(ctx, actions, deps);
  const target = plan.target();
  if (target === null) throw new Error("A proposal planned no change.");
  const tz = await ownerTimezone(ctx);
  const built = plan.build(target, "");
  // Tasks a template copy or a saved project adds only show once planned.
  checkPlannedTasks(built.changes.filter((change) => change.before === null && (change.table === "template_tasks" || (change.table === "tasks" && change.group !== undefined))).length);
  const { list, unshown } = await shownList(ctx, built, tz, now);
  checkListShows(unshown);

  const id = newId("pr");
  const stamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString();
  const text = renderProposal(list, { id, expiresLocal: timeOf(expiresAt, tz) });
  const readsJson = JSON.stringify(plan.reads());
  // Each is one bound parameter, and a statement may hold at most 100 KB (decision 0035).
  if ([readsJson, text].some((value) => sqlBytes(value) > CHUNK_BYTES)) throw new UserError(TOO_LONG);
  const stored = () =>
    db
      .prepare("INSERT INTO proposals (id, actions, reads, text, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'open', ?, ?)")
      .bind(id, actionsJson, readsJson, text, stamp, expiresAt);
  // The trial: apply's own batch, after the proposal's row, rolled back. A list whose apply would fail isn't stored.
  const failed = await trialError(ctx, appliedChange(db, plan, id, new Map(), now), [stored()]);
  if (failed !== null) throw await refusalFor(ctx, plan, failed);

  const statements = [
    // At the cap, the oldest open lists make room (dropped, replaced by this one), so an AI app that never applies can't
    // block new edits. The one it replaces doesn't count and isn't picked. In the batch, so two lists proposed at once
    // each make their own room, and the guard after it still holds exactly ten.
    db
      .prepare(
        "UPDATE proposals SET status = 'dropped', replaced_by = ? WHERE id IN (SELECT id FROM proposals WHERE status = 'open' " +
          "AND expires_at > ? AND id IS NOT ? ORDER BY created_at, rowid LIMIT max(0, (SELECT COUNT(*) FROM proposals " +
          "WHERE status = 'open' AND expires_at > ? AND id IS NOT ?) - ? + 1))",
      )
      .bind(id, stamp, old?.id ?? null, stamp, old?.id ?? null, PROPOSAL_MAX_OPEN),
    db
      .prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) < ? FROM proposals WHERE status = 'open' AND expires_at > ? AND id IS NOT ?")
      .bind(PROPOSAL_MAX_OPEN, stamp, old?.id ?? null),
    stored(),
  ];
  if (old !== null) {
    statements.push(
      db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM proposals WHERE id = ? AND status = 'open' AND expires_at > ?").bind(old.id, stamp),
      db.prepare("UPDATE proposals SET status = 'dropped', replaced_by = ? WHERE id = ?").bind(id, old.id),
    );
  }
  statements.push(db.prepare("DELETE FROM write_guard"));
  try {
    await db.batch(statements);
  } catch (error) {
    // The list it replaces was applied or replaced meanwhile: say so. (The cap's guard can't fail after the drop.)
    if (isGuardFailure(error) && old !== null) await replaceable(db, old.id, now);
    throw error;
  }
  return { kind: "proposal", id, expiresAt, text, list, approveIn: (await settingsRow(ctx)).ai_approval };
}

function parseReads(json: string): Record<string, number | null> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Bad proposal reads.");
  return value as Record<string, number | null>;
}

const splitKey = (key: string) => {
  const at = key.indexOf(":");
  return { table: key.slice(0, at), id: key.slice(at + 1) };
};

/**
 * The fresh plan's rows against the stored ones, in order: every row it updates must be the same row at the same
 * version, and each row it adds stands for the stored row added at the same place (same table), whose id it takes.
 * Answers those ids, or the first key that differs.
 */
function compareReads(stored: Record<string, number | null>, fresh: Record<string, number | null>): { ids: Map<string, string> } | { changed: string } {
  const before = Object.entries(stored);
  const now = Object.entries(fresh);
  const ids = new Map<string, string>();
  for (let i = 0; i < Math.max(before.length, now.length); i++) {
    const was = before[i];
    const is = now[i];
    if (was === undefined || is === undefined) return { changed: (was ?? is)?.[0] ?? "" };
    if (was[1] === null && is[1] === null && splitKey(was[0]).table === splitKey(is[0]).table) {
      ids.set(splitKey(is[0]).id, splitKey(was[0]).id);
      continue;
    }
    if (was[0] !== is[0] || was[1] !== is[1]) return { changed: was[0] };
  }
  return { ids };
}

/** "Contact Pat Example", by its label now (labels.ts), or "A record in this list". */
async function recordNamed(db: Db, key: string): Promise<string> {
  const { table, id } = splitKey(key);
  if (!isChangeTable(table)) return "A record in this list";
  const row = await db.prepare(`SELECT * FROM ${table} WHERE ${primaryKey(table)} = ?`).bind(id).first<Row>();
  return row === null ? "A record in this list" : capitalize(rowLabel(table, row));
}

/** The change with the fresh plan's new ids replaced by the ones the owner was shown. */
function withShownIds(input: ChangeInput, ids: ReadonlyMap<string, string>): ChangeInput {
  if (ids.size === 0) return input;
  const row = (value: Row | null): Row | null =>
    value === null ? null : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? (ids.get(v) ?? v) : v]));
  return {
    ...input,
    target: { ...input.target, id: ids.get(input.target.id) ?? input.target.id },
    changes: input.changes.map((change) => ({ ...change, id: ids.get(change.id) ?? change.id, before: row(change.before), after: row(change.after) })),
  };
}

const withShownText = (text: string, ids: ReadonlyMap<string, string>) =>
  [...ids].reduce((out, [from, to]) => out.split(from).join(to), text);

const applyCtx = (ctx: Ctx): Ctx => ({ ...ctx, plan: undefined, tool: "apply_changes" });

/**
 * The one change apply_changes writes for a plan of proposal `id`: the plan's rows (with the ids the list showed), a
 * leading guard that the proposal is still open, and an extra statement marking it applied. The trial runs it too.
 */
function appliedChange(db: Db, plan: PlanCollector, id: string, ids: ReadonlyMap<string, string>, now: Date): ChangeInput {
  const target = plan.target();
  if (target === null) throw new Error(`Proposal ${id} planned no change.`);
  plan.checkShownIds(ids);
  const summary = short(withShownText(`Applied ${id}: ${plan.summaries().join("; ")}`, ids), 500);
  const built = withShownIds(plan.build(target, summary), ids);
  return {
    ...built,
    changeId: plan.changeId,
    bulk: needsBulk(built.changes),
    leading: [
      db
        .prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM proposals WHERE id = ? AND status = 'open' AND expires_at > ?")
        .bind(id, now.toISOString()),
      ...(built.leading ?? []),
    ],
    extra: [...(built.extra ?? []), db.prepare("UPDATE proposals SET status = 'applied', change_id = ? WHERE id = ?").bind(plan.changeId, id)],
  };
}

/**
 * The last statement of every trial: it always fails, with a message nothing else in the batch can give (commitChange
 * never writes proposals; migration 0014 keeps created_at NOT NULL for it), so the batch always rolls back and its
 * error tells a trial that would apply from one that wouldn't.
 */
export const TRIAL_SENTINEL = "INSERT INTO proposals (id, actions, reads, text, created_at, expires_at) VALUES ('pr_trial', '[]', '{}', '', NULL, '')";
export const isTrialSentinel = (error: unknown) => /NOT NULL constraint failed: proposals\.created_at/.test(errorText(error));

/** Runs the change's own batch (after `prelude`) and rolls it back: null when it would apply, else its error. */
async function trialError(ctx: Ctx, input: ChangeInput, prelude: D1PreparedStatement[] = []): Promise<unknown> {
  const { db } = ctx;
  const { statements } = changeBatch(applyCtx(ctx), input);
  try {
    await db.batch([...prelude, ...statements, db.prepare(TRIAL_SENTINEL)]);
  } catch (error) {
    return isTrialSentinel(error) ? null : error;
  }
  throw new Error("A proposal's trial batch was not rolled back.");
}

const RACE = "A record in this list changed while the list was being made, so nothing was proposed. Send the list again.";

const UNNAMED = "This list can't be applied as one change. Send it as smaller lists.";

/**
 * Why a list's apply would fail, in plain English, from its trial's error, with at most two more trial batches and no
 * new plan (decision 0044, "D1 calls"). A guard failure: the rows alone are tried first, and failing they are a record
 * changed meanwhile. Else a guard an action added (`extra`) fails: with one guard it is that one, with two the first
 * is tried alone; with more, the fixed UNNAMED sentence. The guard's action j and the first later action m that wrote
 * a row the guard is bound to (the plan says which) are the two that can't be in one list; with no such m, the guard
 * failed because of a write from outside the list, a record changed meanwhile.
 */
async function refusalFor(ctx: Ctx, plan: PlanCollector, error: unknown): Promise<unknown> {
  if (isDuplicateEmailFailure(error)) {
    return new UserError("Two people in this list, or one in it and a contact on file, would have the same email. Check the emails and send the list again.", { cause: error });
  }
  if (isForeignKeyFailure(error)) return new UserError("A record this list names was removed while the list was being made. Send the list again.", { cause: error });
  if (isRunningTimerFailure(error)) {
    // Another timer started while the list was being made.
    return new UserError((await runningTimerRefusal(ctx.db, ctx.now)) ?? RACE, { cause: error });
  }
  if (!isGuardFailure(error)) return error;
  const target = plan.target();
  if (target === null) return new UserError(RACE, { cause: error });
  const built = plan.build(target, "trial");
  const input = { ...built, bulk: needsBulk(built.changes) };
  if ((await trialError(ctx, { ...input, extra: [] })) !== null) return new UserError(RACE, { cause: error });
  const extras = input.extra ?? [];
  const [first, second] = extras;
  let failing: number | undefined;
  if (extras.length === 1) failing = 0;
  else if (extras.length === 2 && first !== undefined && second !== undefined) {
    const alone = await trialError(ctx, { ...input, extra: [first] });
    failing = alone !== null && isGuardFailure(alone) ? 0 : 1;
  }
  const statement = failing === undefined ? undefined : extras[failing];
  if (failing === undefined || statement === undefined) return new UserError(UNNAMED, { cause: error });
  const j = plan.extraSources()[failing];
  const ids = guardIds(statement);
  if (j === undefined || ids === undefined) return new UserError(UNNAMED, { cause: error });
  const m = plan.firstWriterAfter(j, ids);
  if (m === undefined) return new UserError(RACE, { cause: error });
  const reason = guardReason(statement) ?? `action ${m} changes what action ${j} checks`;
  return new UserError(`Action ${m} and action ${j} can't be in one list: ${reason}. Send them as two lists.`, { cause: error });
}

/** An applied list's answer: how many actions, and the deals it marked Won (none for a list applied before). */
export type ApplyResult = ChangeResult & { applied: number; wonDeals: string[] };

async function appliedAnswer(db: Db, row: ProposalRow): Promise<ApplyResult> {
  const changeId = row.change_id ?? "";
  const audit = await db.prepare("SELECT summary FROM audit_log WHERE id = ?").bind(changeId).first<{ summary: string }>();
  return { changeId, summary: `${row.id} was already applied: ${audit?.summary ?? `(change ${changeId})`}`, applied: 0, wonDeals: [] };
}

/**
 * apply_changes: the proposal's actions planned again at apply time and written as one change (actor and ctx from the
 * caller, tool apply_changes), only while every row they write is as it was when the list was made. A second apply
 * writes nothing and answers the first change.
 */
export async function applyChanges(caller: Ctx, id: string, deps: Deps & { refuseOnBoard?: string }): Promise<ApplyResult> {
  const ctx: Ctx = { ...caller, memo: new ReadMemo(caller.db) };
  const { db, now } = ctx;
  // The AI app's apply: while the owner approves on the board it writes nothing (the refusal text comes from src/mcp).
  if (deps.refuseOnBoard !== undefined && (await settingsRow(ctx)).ai_approval === "board") throw new UserError(deps.refuseOnBoard);
  const ref = id.trim();
  const row = isProposalId(ref) ? await getProposal(db, ref) : null;
  if (row === null) throw new UserError(`No proposal ${isProposalId(ref) ? ref : "by that id"}. Propose the changes again.`);
  if (row.status === "applied") return appliedAnswer(db, row);
  if (row.status === "dropped") {
    const next = row.replaced_by ?? "a later list";
    throw new UserError(`${row.id} was replaced by ${next}. Apply ${next} if the owner said yes to it.`);
  }
  if (row.expires_at <= now.toISOString()) {
    throw new UserError(`${row.id} expired at ${timeOf(row.expires_at, await ownerTimezone(ctx))}. ${AGAIN}`);
  }

  const actions = recordActionSchema.array().parse(JSON.parse(row.actions));
  let plan: PlanCollector;
  try {
    plan = await planActions({ ...ctx, plan: undefined }, actions, deps);
  } catch (error) {
    if (error instanceof UserError) throw new UserError(`${row.id} can't be applied as it is. ${error.message} ${AGAIN}`, { cause: error });
    throw error;
  }
  const compared = compareReads(parseReads(row.reads), plan.reads());
  if ("changed" in compared) throw new UserError(`${await recordNamed(db, compared.changed)} changed since this list was made. ${AGAIN}`);
  const input = appliedChange(db, plan, row.id, compared.ids, now);
  // Labels, field definitions and the timezone aren't rows the plan writes: the list rendered now must be the one shown.
  const tz = await ownerTimezone(ctx);
  const text = renderProposal(await proposalList(ctx, input, tz, now), { id: row.id, expiresLocal: timeOf(row.expires_at, tz) });
  if (text !== row.text) {
    throw new UserError(`${row.id}'s list would come out different now (a stage, status, field or setting changed). ${AGAIN}`);
  }
  try {
    const result = await commitChange(applyCtx(ctx), input);
    return { ...result, applied: actions.length, wonDeals: wonDealIds(input.changes) };
  } catch (error) {
    const latest = await getProposal(db, row.id);
    if (latest?.status === "applied") return appliedAnswer(db, latest);
    if (latest?.status === "dropped") {
      const next = latest.replaced_by ?? "a later list";
      throw new UserError(`${row.id} was replaced by ${next}. Apply ${next} if the owner said yes to it.`, { cause: error });
    }
    if (error instanceof StaleWriteError || isRunningTimerFailure(error)) {
      throw new UserError(`A record in this list changed since this list was made. ${AGAIN}`, { cause: error });
    }
    if (isDuplicateEmailFailure(error)) throw new UserError(`Someone with an email in this list was added since this list was made. ${AGAIN}`, { cause: error });
    throw error;
  }
}

/** Deletes open proposals past their expiry, and applied or dropped ones a day after they were made. Answers how many. */
export async function deleteExpiredProposals(db: Db, now: Date): Promise<number> {
  const result = await db
    .prepare("DELETE FROM proposals WHERE (status = 'open' AND expires_at <= ?) OR (status <> 'open' AND created_at <= ?)")
    .bind(now.toISOString(), new Date(now.getTime() - KEEP_CLOSED_MS).toISOString())
    .run();
  return result.meta.changes;
}
