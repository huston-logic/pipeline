// add_rule, update_rule, pause_rule, resume_rule, list_rules and preview_rule, plus the hourly run (runRules) and the
// brief's gone-quiet list (listQuietDeals). The rules themselves are pure functions in src/rules/engine.ts; this file
// loads their data and writes their results. Rules are never deleted, only paused. Decision 0010.
import { z } from "zod";
import type { ActivityType, Db, RuleRow, RuleType, StageRow, TaskRow } from "../db/db.ts";
import { listRules as listRuleRows, listStages } from "../db/queries.ts";
import { newId } from "../ids.ts";
import {
  DAY_MS,
  type EngineActivity,
  type EngineDeal,
  type EngineRule,
  evaluateRules,
  type PreviewHit,
  PREVIEW_DAYS,
  previewRule,
  quietDeals,
  type RuleParams,
} from "../rules/engine.ts";
import { formatLocal } from "../time.ts";
import { type ChangeResult, commitChange, type Ctx, isFireKeyFailure, updatedRow } from "./change.ts";
import { capitalize, joinAnd, rowLabel, short, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { dealLabel, untrustedFields } from "./labels.ts";
import { findStage, ownerTimezone, stageLabels } from "./lookup.ts";

export type { RuleParams };

export interface RuleSettings {
  /** Stage key or label (stage_followup, on_stage_enter). */
  stage?: string;
  /** stage_followup: days in the stage with no contact; gone_quiet: days with no contact. */
  days?: number;
  /** The task title; may use {deal}, {contact} and {stage}. */
  title?: string;
  /** on_stage_enter: the task is due this many days after the deal entered the stage. */
  dueInDays?: number;
}

export interface RuleInput extends RuleSettings {
  type: RuleType;
  /** Plain English; generated from the parameters when left out. */
  description?: string;
}

export interface RulePatch extends Omit<RuleSettings, "title"> {
  /** null puts back stage_followup's default title. */
  title?: string | null;
  description?: string;
}

const MAX_TITLE = 200;
/** The most `days` a rule may wait (stage_followup, gone_quiet). */
const MAX_DAYS = 365;
const MAX_DESCRIPTION = 500;
const PLACEHOLDERS = ["deal", "contact", "stage"];

const stage = z.string().trim().min(1).max(200);
const title = z.string().trim().min(1).max(MAX_TITLE);
const days = z.number().int().min(1).max(MAX_DAYS);
const dueInDays = z.number().int().min(0).max(365);

// `since` is the cut-over the services set (decision 0010). It is read back from storage but never taken from a request:
// checkParams leaves it out of what it returns, and the RuleSettings type has no field for it.
const since = z.iso.datetime();

const SCHEMAS = {
  stage_followup: z.strictObject({ type: z.literal("stage_followup"), stage, days, title: title.optional(), since: since.optional() }),
  on_stage_enter: z.strictObject({ type: z.literal("on_stage_enter"), stage, title, dueInDays, since: since.optional() }),
  gone_quiet: z.strictObject({ type: z.literal("gone_quiet"), days }),
} satisfies Record<Exclude<RuleType, "lead_followup">, z.ZodType<RuleParams>>;

// lead_followup is allowed in storage (migration 0006) but has no schema until the leads rules task adds one.
const schemaFor = (type: RuleType): z.ZodType<RuleParams> | undefined =>
  (SCHEMAS as Partial<Record<RuleType, z.ZodType<RuleParams>>>)[type];

const HELP: Record<string, string> = {
  stage: "the stage to watch: its key or label",
  days: "a whole number of days from 1 to 365",
  dueInDays: "a whole number of days from 0 to 365",
  title: `the task title, up to ${MAX_TITLE} characters; it may use {deal}, {contact} and {stage}`,
};

const TAKES: Record<RuleType, string> = {
  stage_followup: "stage and days, and optionally title",
  on_stage_enter: "stage, title and dueInDays",
  gone_quiet: "only days",
  lead_followup: "nothing yet",
};

const aRule = (type: RuleType) => `${withArticle(type)} rule`;

function paramsError(type: RuleType, value: Record<string, unknown>, issues: readonly z.core.$ZodIssue[]): UserError {
  const sentences = issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      return `${capitalize(aRule(type))} doesn't take ${issue.keys.map((key) => `"${key}"`).join(", ")}.`;
    }
    const key = String(issue.path[0] ?? "");
    const help = HELP[key] ?? "set correctly";
    return value[key] === undefined
      ? `${capitalize(aRule(type))} needs "${key}" (${help}).`
      : `"${key}" must be ${help}.`;
  });
  return new UserError(`Fix the rule: ${[...new Set(sentences)].join(" ")} ${capitalize(aRule(type))} takes ${TAKES[type]}.`);
}

function checkTitle(template: string | undefined): void {
  if (template === undefined) return;
  for (const [, name] of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(name ?? "")) {
      throw new UserError(`A rule's title can use {deal}, {contact} and {stage} only; {${name}} isn't one. Change the title.`);
    }
  }
}

/** Only open stages: rules watch open deals, so a closed stage would never fire. */
async function ruleStage(db: Db, ref: string): Promise<StageRow> {
  const found = await findStage(db, ref);
  if (found.kind === "open") return found;
  const open = (await listStages(db)).filter((s) => s.kind === "open");
  const list = open.map((s) => `${s.label} (${s.key})`).join(", ");
  throw new UserError(
    `Rules only watch open deals, so a rule can't use ${found.label} (${withArticle(found.kind.replace("_", " "))} stage). ` +
      `Pick an open stage: ${list}.`,
  );
}

const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

/** Checked, normalized parameters (the stage as its key), and the stage's label for the description. */
async function checkParams(db: Db, type: RuleType, settings: RuleSettings): Promise<{ params: RuleParams; stageLabel: string | null }> {
  const schema = Object.hasOwn(SCHEMAS, type) ? schemaFor(type) : undefined;
  if (!schema) {
    throw new UserError(`"${type}" isn't a rule type. Use stage_followup, on_stage_enter or gone_quiet.`);
  }
  const value = defined({ type, ...settings });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw paramsError(type, value, parsed.error.issues);
  const params = parsed.data as RuleParams;
  if (params.type === "gone_quiet") return { params: { type: params.type, days: params.days }, stageLabel: null };
  checkTitle(params.title);
  const found = await ruleStage(db, params.stage);
  if (params.type === "stage_followup") {
    const normalized: RuleParams = { type: params.type, stage: found.key, days: params.days };
    if (params.title !== undefined) normalized.title = params.title;
    return { params: normalized, stageLabel: found.label };
  }
  return {
    params: { type: params.type, stage: found.key, title: params.title, dueInDays: params.dueInDays },
    stageLabel: found.label,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeRule(params: RuleParams, stageLabel: string | null): string {
  const where = stageLabel ?? (params.type === "gone_quiet" ? "" : params.stage);
  switch (params.type) {
    case "stage_followup": {
      const task = params.title === undefined ? "a follow-up task" : `the task "${params.title}"`;
      return `When a deal has sat in ${where} for ${plural(params.days, "day")} with no contact logged, add ${task}.`;
    }
    case "on_stage_enter": {
      const due = params.dueInDays === 0 ? "the same day" : `${plural(params.dueInDays, "day")} later`;
      return `When a deal enters ${where}, add the task "${params.title}", due ${due}.`;
    }
    case "gone_quiet":
      return `Flag any open deal with no contact logged for ${plural(params.days, "day")} in the daily brief.`;
  }
}

function cleanDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") throw new UserError("A rule's description can't be blank. Leave it out to have one written for you.");
  if (line.length > MAX_DESCRIPTION) {
    throw new UserError(`A rule's description can be at most ${MAX_DESCRIPTION} characters (got ${line.length}).`);
  }
  return line;
}

/** The stored parameters, or null when they no longer pass the checks (the rule is then skipped, never guessed). */
export function parseRuleParams(row: Pick<RuleRow, "type" | "params">): RuleParams | null {
  try {
    const parsed = schemaFor(row.type)?.safeParse(JSON.parse(row.params));
    return parsed?.success ? (parsed.data as RuleParams) : null;
  } catch {
    return null;
  }
}

async function findRule(db: Db, ref: string): Promise<RuleRow> {
  const id = ref.trim();
  if (id === "") throw new UserError("Say which rule: give its id (ru_...) from list_rules.");
  const row = await db.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<RuleRow>();
  if (!row) throw new UserError(`There's no rule "${id}". Use list_rules to find the rule's id (ru_...).`);
  return row;
}

const ruleName = (row: RuleRow) => `rule ${row.id}`;

export async function addRule(ctx: Ctx, input: RuleInput): Promise<ChangeResult & { ruleId: string }> {
  const { type, description: given, ...settings } = input;
  const { params, stageLabel } = await checkParams(ctx.db, type, settings);
  const description = cleanDescription(given) ?? describeRule(params, stageLabel);
  const now = ctx.now.toISOString();
  const row: RuleRow = {
    id: newId("ru"),
    type: params.type,
    params: JSON.stringify(params),
    description,
    active: 1,
    created_by: ctx.actor,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  const result = await commitChange(ctx, {
    target: { table: "rules", id: row.id },
    summary: `Added rule ${row.id}: ${short(description, 200)}`,
    changes: [{ table: "rules", id: row.id, before: null, after: row }],
  });
  return { ...result, ruleId: row.id };
}

const PARAM_LABELS: Record<string, string> = { stage: "stage", days: "days", title: "title", dueInDays: "due in days" };

export async function updateRule(ctx: Ctx, ref: string, patch: RulePatch): Promise<ChangeResult & { ruleId: string }> {
  const { db } = ctx;
  const before = await findRule(db, ref);
  const stored = parseRuleParams(before);
  if (stored === null) throw new Error(`Rule ${before.id} has unreadable parameters.`);
  const { description: given, title: newTitle, ...settings } = patch;
  const merged: RuleSettings = { ...stored, ...defined({ ...settings, title: newTitle ?? undefined }) };
  if (newTitle === null) {
    if (stored.type === "gone_quiet") {
      throw new UserError(`Fix the rule: A gone_quiet rule doesn't take "title". A gone_quiet rule takes ${TAKES.gone_quiet}.`);
    }
    if (stored.type === "on_stage_enter") {
      throw new UserError("An on_stage_enter rule needs a title, so it can't go back to a default. Give the new title instead.");
    }
    delete merged.title;
  }
  const { params, stageLabel } = await checkParams(db, stored.type, merged);
  const description = cleanDescription(given);

  const changed = Object.keys(PARAM_LABELS).filter(
    (key) => JSON.stringify((params as Record<string, unknown>)[key]) !== JSON.stringify((stored as Record<string, unknown>)[key]),
  );
  const paramsChanged = changed.length > 0;
  const nextDescription = description ?? (paramsChanged ? describeRule(params, stageLabel) : before.description);
  if (!paramsChanged && nextDescription === before.description) {
    throw new UserError(`Nothing to change on ${ruleName(before)}: every value you gave is already set.`);
  }
  // Entries into the stage before this moment must not fire for a rule that now watches it (the owner never set `since`).
  const moved = params.type === "on_stage_enter" && stored.type === "on_stage_enter" && params.stage !== stored.stage;
  const cutOver = moved ? ctx.now.toISOString() : stored.type === "gone_quiet" ? undefined : stored.since;
  if (params.type !== "gone_quiet" && cutOver !== undefined) params.since = cutOver;
  const after = updatedRow(before, { params: JSON.stringify(params), description: nextDescription }, ctx.now);
  const labels = changed.map((key) => PARAM_LABELS[key] ?? key);
  if (description !== undefined && description !== before.description) labels.push("description");
  const result = await commitChange(ctx, {
    target: { table: "rules", id: before.id },
    summary: `Updated ${ruleName(before)}: ${joinAnd(labels)}; now: ${short(nextDescription, 200)}`,
    changes: [{ table: "rules", id: before.id, before, after }],
  });
  return { ...result, ruleId: before.id };
}

/**
 * The parameters of a rule that becomes active again (resume_rule, or an undo of pause_rule): stage entries from before
 * `now` (made while paused, or already overdue) must not fire all at once, so stage rules get `since` = now.
 */
export function resumedParams(row: Pick<RuleRow, "type" | "params">, now: Date): string {
  const stored = parseRuleParams(row);
  if (stored === null || stored.type === "gone_quiet") return row.params;
  return JSON.stringify({ ...stored, since: now.toISOString() });
}

async function setActive(ctx: Ctx, ref: string, active: boolean): Promise<ChangeResult & { ruleId: string }> {
  const before = await findRule(ctx.db, ref);
  if ((before.active === 1) === active) {
    throw new UserError(
      active
        ? `${capitalize(ruleName(before))} is already active. Pause it with pause_rule.`
        : `${capitalize(ruleName(before))} is already paused. Resume it with resume_rule.`,
    );
  }
  const patch: Partial<RuleRow> = { active: active ? 1 : 0 };
  if (active) patch.params = resumedParams(before, ctx.now);
  const after = updatedRow(before, patch, ctx.now);
  const result = await commitChange(ctx, {
    target: { table: "rules", id: before.id },
    summary: `${active ? "Resumed" : "Paused"} ${ruleName(before)}: ${short(before.description, 200)}`,
    changes: [{ table: "rules", id: before.id, before, after }],
  });
  return { ...result, ruleId: before.id };
}

export const pauseRule = (ctx: Ctx, ref: string) => setActive(ctx, ref, false);
export const resumeRule = (ctx: Ctx, ref: string) => setActive(ctx, ref, true);

export interface RuleView {
  id: string;
  type: RuleType;
  description: string;
  active: boolean;
  /** null when the stored parameters can't be read (the rule is skipped). */
  params: RuleParams | null;
  /** The watched stage's current label (stage rules only). */
  stageLabel: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  timesFired: number;
}

export async function listRules(db: Db): Promise<RuleView[]> {
  const rules = await listRuleRows(db);
  const labels = await stageLabels(db);
  const counts = new Map(
    (await db.prepare("SELECT rule_id, COUNT(*) AS n FROM rule_firings GROUP BY rule_id").all<{ rule_id: string; n: number }>())
      .results.map((r) => [r.rule_id, r.n]),
  );
  return rules.map((row) => {
    const params = parseRuleParams(row);
    const key = params && params.type !== "gone_quiet" ? params.stage : null;
    return {
      id: row.id,
      type: row.type,
      description: row.description,
      active: row.active === 1,
      params,
      stageLabel: key === null ? null : (labels.get(key) ?? key),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      timesFired: counts.get(row.id) ?? 0,
    };
  });
}

type DealJoin = {
  id: string;
  title: string;
  untrusted_fields: string;
  contact_id: string;
  contact_name: string;
  contact_untrusted: string;
  stage_key: string;
  stage_label: string;
  status: EngineDeal["status"];
  archived: number;
  stage_entered_at: string;
  last_activity_at: string | null;
  created_at: string;
};

/** Deals that are not archived (only open ones when `openOnly`), shaped for the engine. */
async function engineDeals(db: Db, openOnly: boolean): Promise<EngineDeal[]> {
  const found = await db
    .prepare(
      `SELECT d.id, d.title, d.untrusted_fields, d.contact_id, c.name AS contact_name, c.untrusted_fields AS contact_untrusted,
         d.stage_key, s.label AS stage_label, d.status, d.archived, d.stage_entered_at, d.last_activity_at, d.created_at
       FROM deals d JOIN contacts c ON c.id = d.contact_id JOIN stages s ON s.key = d.stage_key
       WHERE d.archived = 0 ${openOnly ? "AND d.status = 'open'" : ""} ORDER BY s.position, d.stage_entered_at, d.id`,
    )
    .all<DealJoin>();
  return found.results.map((row) => ({
    id: row.id,
    title: row.title,
    untrusted_fields: row.untrusted_fields,
    contact: { id: row.contact_id, name: row.contact_name, untrusted_fields: row.contact_untrusted },
    stageKey: row.stage_key,
    stageLabel: row.stage_label,
    status: row.status,
    archived: row.archived === 1,
    stageEnteredAt: row.stage_entered_at,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
  }));
}

async function activeRules(db: Db): Promise<EngineRule[]> {
  return (await listRuleRows(db, { activeOnly: true })).flatMap((row) => {
    const params = parseRuleParams(row);
    return params === null ? [] : [{ id: row.id, params, active: true, createdAt: row.created_at }];
  });
}

export type RuleRunCounts = {
  /** Active rules with readable parameters. */
  rules: number;
  /** Tasks created. */
  fired: number;
  /** Firings another run made first (a race); skipped. */
  alreadyFired: number;
  /** Firings that could not be written; the next run tries them again. */
  failed: number;
  /** Firings over MAX_FIRINGS_PER_RUN, left for the next hourly run. */
  deferred: number;
};

/**
 * One run writes at most this many firings (one D1 batch each), so a catch-up after a new rule stays inside the free
 * plan's per-invocation limits and leaves room for the daily brief in the same invocation. The rest fire next hour;
 * their fire keys are not written yet, so nothing is lost or doubled (decision 0010).
 */
export const MAX_FIRINGS_PER_RUN = 25;

/** The hourly run: one system change per firing, each creating its task with the rule_firings row in `extra`. */
export async function runRules(db: Db, now: Date): Promise<RuleRunCounts> {
  const rules = await activeRules(db);
  const counts: RuleRunCounts = { rules: rules.length, fired: 0, alreadyFired: 0, failed: 0, deferred: 0 };
  const stageRules = rules.filter((rule) => rule.params.type !== "gone_quiet");
  if (stageRules.length === 0) return counts;

  const deals = await engineDeals(db, true);
  const fired = await db
    .prepare(
      `SELECT fire_key FROM rule_firings WHERE deal_id IN (SELECT id FROM deals WHERE status = 'open' AND archived = 0)`,
    )
    .all<{ fire_key: string }>();
  const due = evaluateRules({ now, rules: stageRules, deals, firedKeys: new Set(fired.results.map((r) => r.fire_key)) });
  if (due.length === 0) return counts;
  const firings = due.slice(0, MAX_FIRINGS_PER_RUN);
  counts.deferred = due.length - firings.length;

  const tz = await ownerTimezone(db);
  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const ctx: Ctx = { db, now, actor: "system", tool: "rules" };
  const at = now.toISOString();
  for (const firing of firings) {
    const deal = byId.get(firing.dealId);
    if (!deal) continue;
    const task: TaskRow = {
      id: newId("tk"),
      deal_id: firing.dealId,
      contact_id: firing.contactId,
      title: firing.title.slice(0, 500),
      due_at: firing.dueAt,
      done_at: null,
      snoozed_until: null,
      source: firing.ruleId,
      untrusted_fields: firing.titleUntrusted ? '["title"]' : "[]",
      version: 1,
      created_at: at,
      updated_at: at,
    };
    const record = db
      .prepare(
        "INSERT INTO rule_firings (id, rule_id, deal_id, contact_id, fire_key, task_id, fired_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(newId("rf"), firing.ruleId, firing.dealId, firing.contactId, firing.fireKey, task.id, at);
    try {
      await commitChange(ctx, {
        target: { table: "tasks", id: task.id },
        summary:
          `Rule ${firing.ruleId} added ${rowLabel("tasks", task)} for ${dealLabel(deal, deal.contact)}, ` +
          `due ${formatLocal(task.due_at ?? at, tz)}`,
        changes: [{ table: "tasks", id: task.id, before: null, after: task }],
        extra: [record],
      });
      counts.fired += 1;
    } catch (error) {
      if (isFireKeyFailure(error)) counts.alreadyFired += 1;
      else counts.failed += 1;
    }
  }
  return counts;
}

export interface QuietDeal {
  dealId: string;
  ruleId: string;
  quietDays: number;
  title: string;
  contactName: string;
  /** Which of title and contactName came from outside. */
  untrusted_fields: ("title" | "contactName")[];
}

/** Open deals the active gone_quiet rules flag now (the daily brief's list), one entry per deal and rule. */
export async function listQuietDeals(db: Db, now: Date): Promise<QuietDeal[]> {
  const rules = (await activeRules(db)).filter((rule) => rule.params.type === "gone_quiet");
  if (rules.length === 0) return [];
  const deals = await engineDeals(db, true);
  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  return quietDeals({ now, rules, deals }).flatMap((flag) => {
    const deal = byId.get(flag.dealId);
    if (!deal) return [];
    const outside = untrustedFields(deal);
    const outsideContact = untrustedFields(deal.contact);
    return [
      {
        ...flag,
        title: deal.title,
        contactName: deal.contact.name,
        untrusted_fields: [
          ...(outside.has("title") ? (["title"] as const) : []),
          ...(outsideContact.has("name") ? (["contactName"] as const) : []),
        ],
      },
    ];
  });
}

const PREVIEW_TYPES: ActivityType[] = ["form", "email", "call", "meeting", "note", "stage_change"];

/**
 * How many days before the preview window an activity can still change the answer. A stage_followup hit is a stay that
 * began at most `days` before its firing, a gone_quiet hit a quiet spell that began at most `days` before it; an older
 * activity only moves that start further back, where it cannot produce a hit. An on_stage_enter hit is the entry
 * itself, so it needs nothing before the window.
 * This is exact given two invariants the services keep (decision 0020): every stage_change is at or after its deal's
 * created_at, so a first stay rebuilt from created_at starts no later than the true one; and the last stage_change's
 * `to` is the deal's stage_key, so the current stay is always the one starting at stage_entered_at.
 */
function lookbackDays(params: RuleParams): number {
  return params.type === "on_stage_enter" ? 0 : params.days;
}

export interface RulePreview {
  /** The saved rule previewed, or null for a rule not added yet. */
  ruleId: string | null;
  description: string;
  params: RuleParams;
  /** The start of the window (UTC ISO): 30 days before now. */
  since: string;
  hits: (PreviewHit & { wouldFireAtLocal: string })[];
  /** Distinct deals among the hits. */
  dealCount: number;
}

export type PreviewRequest = { rule?: string } & Partial<RuleInput>;

/** What a saved rule (by id) or a new one (by its settings) would have caught in the last 30 days. Writes nothing. */
export async function previewRuleFor(db: Db, now: Date, request: PreviewRequest): Promise<RulePreview> {
  const { rule: ref, type, description, ...settings } = request;
  const hasSettings = [type, description, ...Object.values(settings)].some((value) => value !== undefined);
  if (ref !== undefined && hasSettings) {
    throw new UserError("Give either a rule id or the rule's settings (type, stage, days, ...), not both.");
  }
  let preview: Pick<RulePreview, "ruleId" | "description" | "params">;
  if (ref !== undefined) {
    const row = await findRule(db, ref);
    const params = parseRuleParams(row);
    if (params === null) throw new Error(`Rule ${row.id} has unreadable parameters.`);
    preview = { ruleId: row.id, description: row.description, params };
  } else {
    if (type === undefined) {
      throw new UserError(
        "Give a rule id (ru_...) to preview a saved rule, or a type with its settings to preview a new one.",
      );
    }
    const { params, stageLabel } = await checkParams(db, type, settings);
    preview = { ruleId: null, description: cleanDescription(description) ?? describeRule(params, stageLabel), params };
  }

  const tz = await ownerTimezone(db);
  // A hit in the window comes from a stage stay or a quiet spell that started at most the rule's own `days` before the
  // window (an on_stage_enter hit is the entry itself, inside the window), so older activities cannot change the answer
  // and are not read (decision 0010, narrowed in run 2 R7).
  const lookback = new Date(now.getTime() - (PREVIEW_DAYS + lookbackDays(preview.params)) * DAY_MS).toISOString();
  const activities = await db
    .prepare(
      `SELECT deal_id, contact_id, type, occurred_at, data FROM activities
       WHERE type IN (${PREVIEW_TYPES.map(() => "?").join(", ")}) AND occurred_at >= ?`,
    )
    .bind(...PREVIEW_TYPES, lookback)
    .all<{ deal_id: string | null; contact_id: string | null; type: ActivityType; occurred_at: string; data: string | null }>();
  const hits = previewRule(preview.params, {
    now,
    deals: await engineDeals(db, false),
    activities: activities.results.map(
      (a): EngineActivity => ({ dealId: a.deal_id, contactId: a.contact_id, type: a.type, occurredAt: a.occurred_at, data: a.data }),
    ),
  });
  return {
    ...preview,
    since: new Date(now.getTime() - PREVIEW_DAYS * DAY_MS).toISOString(),
    hits: hits.map((hit) => ({ ...hit, wouldFireAtLocal: formatLocal(hit.wouldFireAt, tz) })),
    dealCount: new Set(hits.map((hit) => hit.dealId)).size,
  };
}
