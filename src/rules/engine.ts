// The rules engine: pure functions over plain data, no database. runRules (src/services/rules.ts) loads the data,
// calls evaluateRules and writes each firing; the daily brief (task 7) calls quietDeals; preview_rule calls
// previewRule. Decision 0010 explains the rules and the preview's approximations. Import-free apart from labels.ts.
import type { ActivityType, DealStatus } from "../db/db.ts";
import { dealLabel, untrustedFields } from "../services/labels.ts";

export const DAY_MS = 86_400_000;
/** How far back preview_rule looks. */
export const PREVIEW_DAYS = 30;

/** The activity types that count as contact (the rest, stage_change and system, do not). */
const CONTACT_TYPES: ReadonlySet<ActivityType> = new Set(["form", "email", "call", "meeting", "note"]);

/**
 * `since` (UTC ISO) is a cut-over the services set, never the owner: when a rule is resumed, or an on_stage_enter rule
 * is pointed at another stage, stage entries before that moment never fire (decision 0010).
 */
export type RuleParams =
  | { type: "stage_followup"; stage: string; days: number; title?: string; since?: string }
  | { type: "on_stage_enter"; stage: string; title: string; dueInDays: number; since?: string }
  | { type: "gone_quiet"; days: number };

export const DEFAULT_FOLLOWUP_TITLE = "Follow up with {contact} about {deal}";

export interface EngineRule {
  id: string;
  params: RuleParams;
  active: boolean;
  createdAt: string;
}

/** A deal with what the title templates and the safe labels need. `untrusted_fields` are the rows' own JSON lists. */
export interface EngineDeal {
  id: string;
  title: string;
  untrusted_fields: string;
  contact: { id: string; name: string; untrusted_fields: string };
  stageKey: string;
  stageLabel: string;
  status: DealStatus;
  archived: boolean;
  stageEnteredAt: string;
  /** The latest contact-type activity (form, email, call, meeting, note), or null. */
  lastActivityAt: string | null;
  createdAt: string;
}

export interface EngineActivity {
  dealId: string | null;
  contactId: string | null;
  type: ActivityType;
  occurredAt: string;
  /** JSON; {"from":"<stage>","to":"<stage>"} on a stage_change. */
  data: string | null;
}

export interface Firing {
  ruleId: string;
  dealId: string;
  contactId: string;
  fireKey: string;
  title: string;
  /** The title pulled in text from outside ({contact} or {deal} listed as untrusted): store it with ["title"]. */
  titleUntrusted: boolean;
  dueAt: string;
  stageEnteredAt: string;
}

export const fireKeyOf = (ruleId: string, dealId: string, stageEnteredAt: string) => `${ruleId}:${dealId}:${stageEnteredAt}`;

const ms = (iso: string) => Date.parse(iso);
const iso = (at: number) => new Date(at).toISOString();
const isLive = (deal: EngineDeal) => deal.status === "open" && !deal.archived;

/** Fills {deal}, {contact} and {stage}; `untrusted` when a filled-in value came from outside. */
export function renderTitle(template: string, deal: EngineDeal): { title: string; untrusted: boolean } {
  let untrusted = false;
  const values: Record<string, { text: string; outside: boolean }> = {
    deal: { text: deal.title, outside: untrustedFields(deal).has("title") },
    contact: { text: deal.contact.name, outside: untrustedFields(deal.contact).has("name") },
    stage: { text: deal.stageLabel, outside: false },
  };
  const title = template.replace(/\{(deal|contact|stage)\}/g, (_match, name: string) => {
    const value = values[name];
    if (!value) return "";
    if (value.outside) untrusted = true;
    return value.text;
  });
  return { title: title.replace(/\s+/g, " ").trim(), untrusted };
}

/** No contact-type activity after the deal entered its stage. */
const noContactSinceEntry = (deal: EngineDeal) =>
  deal.lastActivityAt === null || ms(deal.lastActivityAt) <= ms(deal.stageEnteredAt);

/** When the rule fires for the deal's current stage entry (null: not due yet, or never for this entry). */
function dueFor(rule: EngineRule, deal: EngineDeal, now: Date): { dueAt: string; template: string } | null {
  const { params } = rule;
  if (params.type === "gone_quiet" || params.stage !== deal.stageKey) return null;
  const entered = ms(deal.stageEnteredAt);
  if (params.since !== undefined && entered < ms(params.since)) return null;
  if (params.type === "stage_followup") {
    const at = entered + params.days * DAY_MS;
    if (at > now.getTime() || !noContactSinceEntry(deal)) return null;
    return { dueAt: iso(at), template: params.title ?? DEFAULT_FOLLOWUP_TITLE };
  }
  if (entered < ms(rule.createdAt)) return null;
  return { dueAt: iso(entered + params.dueInDays * DAY_MS), template: params.title };
}

/** The tasks the active stage rules owe now, leaving out stage entries already in `firedKeys`. */
export function evaluateRules(input: {
  now: Date;
  rules: EngineRule[];
  deals: EngineDeal[];
  firedKeys: ReadonlySet<string>;
}): Firing[] {
  const firings: Firing[] = [];
  for (const rule of input.rules) {
    if (!rule.active) continue;
    for (const deal of input.deals) {
      if (!isLive(deal)) continue;
      const fireKey = fireKeyOf(rule.id, deal.id, deal.stageEnteredAt);
      if (input.firedKeys.has(fireKey)) continue;
      const due = dueFor(rule, deal, input.now);
      if (due === null) continue;
      const { title, untrusted } = renderTitle(due.template, deal);
      firings.push({
        ruleId: rule.id,
        dealId: deal.id,
        contactId: deal.contact.id,
        fireKey,
        title,
        titleUntrusted: untrusted,
        dueAt: due.dueAt,
        stageEnteredAt: deal.stageEnteredAt,
      });
    }
  }
  return firings;
}

/** The time a deal's quiet spell is measured from: its last contact, or its creation if there was none. */
const lastContactOf = (deal: { lastActivityAt: string | null; createdAt: string }) => deal.lastActivityAt ?? deal.createdAt;

/** No contact (or, with none yet, since the deal was added) for at least `days` days. Shared with list_deals. */
export function isQuiet(deal: { lastActivityAt: string | null; createdAt: string }, now: Date, days: number): boolean {
  return ms(lastContactOf(deal)) <= now.getTime() - days * DAY_MS;
}

/** Open deals flagged by each active gone_quiet rule, with whole days since the last contact. */
export function quietDeals(input: {
  now: Date;
  rules: EngineRule[];
  deals: EngineDeal[];
}): { dealId: string; ruleId: string; quietDays: number }[] {
  const flagged: { dealId: string; ruleId: string; quietDays: number }[] = [];
  for (const rule of input.rules) {
    if (!rule.active || rule.params.type !== "gone_quiet") continue;
    for (const deal of input.deals) {
      if (!isLive(deal) || !isQuiet(deal, input.now, rule.params.days)) continue;
      const quietDays = Math.floor((input.now.getTime() - ms(lastContactOf(deal))) / DAY_MS);
      flagged.push({ dealId: deal.id, ruleId: rule.id, quietDays });
    }
  }
  return flagged;
}

export interface PreviewHit {
  dealId: string;
  contactId: string;
  /** A safe label: outside titles and names become id labels (src/services/labels.ts). */
  label: string;
  wouldFireAt: string;
}

type Stay = { stageKey: string; from: number; to: number | null };

function stageKeyOf(data: string | null, side: "from" | "to"): string | null {
  if (data === null) return null;
  try {
    const value: unknown = JSON.parse(data);
    const key = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[side] : undefined;
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

/**
 * The deal's stays in each stage, oldest first, from its stage_change activities: the first stay starts at creation
 * in the earliest change's `from` stage (or the current stage when it never moved), and the current stay starts at
 * stage_entered_at.
 */
function stageHistory(deal: EngineDeal, changes: EngineActivity[]): Stay[] {
  const moves = changes
    .map((a) => ({ at: ms(a.occurredAt), from: stageKeyOf(a.data, "from"), to: stageKeyOf(a.data, "to") }))
    .filter((m): m is { at: number; from: string; to: string } => m.from !== null && m.to !== null)
    .sort((a, b) => a.at - b.at);
  const stays: Stay[] = [{ stageKey: moves[0]?.from ?? deal.stageKey, from: ms(deal.createdAt), to: null }];
  for (const move of moves) {
    const current = stays.at(-1);
    if (current) current.to = move.at;
    stays.push({ stageKey: move.to, from: move.at, to: null });
  }
  const last = stays.at(-1);
  if (last && last.stageKey === deal.stageKey) last.from = ms(deal.stageEnteredAt);
  return stays;
}

/** When the deal first counted as quiet inside [start, end], given its contact times (sorted). */
function firstQuietAt(baseline: number, contacts: number[], days: number, start: number, end: number): number | null {
  const marks = [baseline, ...contacts.filter((at) => at > baseline)];
  for (let i = 0; i < marks.length; i++) {
    const quietFrom = Math.max((marks[i] ?? 0) + days * DAY_MS, start);
    const until = marks[i + 1] ?? Number.POSITIVE_INFINITY;
    if (quietFrom < until && quietFrom <= end) return quietFrom;
  }
  return null;
}

/**
 * The deals the rule would have caught in the last 30 days, without changing anything. Each stage rule hit is one
 * stage stay (a deal can appear once per entry); gone_quiet lists each open deal once, at the first moment it was
 * quiet in the window. Exact thresholds are reported; the real cron runs hourly, so it fires up to an hour later.
 */
export function previewRule(
  params: RuleParams,
  data: { now: Date; deals: EngineDeal[]; activities: EngineActivity[] },
): PreviewHit[] {
  const end = data.now.getTime();
  const start = end - PREVIEW_DAYS * DAY_MS;
  const hits: PreviewHit[] = [];
  // Grouped once: a deal's own activities, and the contact-only ones (no deal) of its contact.
  const byDeal = new Map<string, EngineActivity[]>();
  const byContact = new Map<string, EngineActivity[]>();
  for (const activity of data.activities) {
    const { dealId } = activity;
    const [key, groups] = dealId !== null ? [dealId, byDeal] : [activity.contactId, byContact];
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(activity);
    else groups.set(key, [activity]);
  }
  for (const deal of data.deals) {
    if (deal.archived) continue;
    const mine = [...(byDeal.get(deal.id) ?? []), ...(byContact.get(deal.contact.id) ?? [])];
    const contacts = mine
      .filter((a) => CONTACT_TYPES.has(a.type))
      .map((a) => ms(a.occurredAt))
      .sort((a, b) => a - b);
    const hit = (at: number) =>
      hits.push({ dealId: deal.id, contactId: deal.contact.id, label: dealLabel(deal, deal.contact), wouldFireAt: iso(at) });

    if (params.type === "gone_quiet") {
      if (!isLive(deal)) continue;
      const at = firstQuietAt(ms(deal.createdAt), contacts, params.days, start, end);
      if (at !== null) hit(at);
      continue;
    }
    const changes = mine.filter((a) => a.dealId === deal.id && a.type === "stage_change");
    for (const stay of stageHistory(deal, changes)) {
      if (stay.stageKey !== params.stage) continue;
      const left = stay.to ?? Number.POSITIVE_INFINITY;
      const at = params.type === "on_stage_enter" ? stay.from : stay.from + params.days * DAY_MS;
      if (at < start || at > end || at >= left) continue;
      if (params.type === "stage_followup" && contacts.some((c) => c > stay.from && c <= at)) continue;
      hit(at);
    }
  }
  return hits.sort((a, b) => a.wouldFireAt.localeCompare(b.wouldFireAt) || a.dealId.localeCompare(b.dealId));
}
