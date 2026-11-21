// The rules engine: pure functions over plain data, no database. runRules (src/services/rules.ts) loads the data,
// calls evaluateRules and evaluateLeadRules and writes each firing; the daily brief (task 7) calls quietDeals;
// preview_rule calls previewRule or previewLeadRule. Decisions 0010 and 0026 explain the rules and the previews.
// Import-free apart from labels.ts (and types).
import type { ActivityType, DealStatus } from "../db/db.ts";
import { contactName, dealLabel, untrustedFields } from "../services/labels.ts";
import type { LeadStatus } from "../services/lead-status.ts";

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
  | { type: "gone_quiet"; days: number }
  | { type: "lead_followup"; status: LeadFollowupStatus; days: number; title?: string; since?: string };

/** The rules that watch deals; lead_followup watches leads (decision 0022). */
export type DealRuleParams = Exclude<RuleParams, { type: "lead_followup" }>;

/** The lead statuses a lead_followup rule can watch. */
export const LEAD_FOLLOWUP_STATUSES = ["new", "contacted"] as const satisfies readonly LeadStatus[];
export type LeadFollowupStatus = (typeof LEAD_FOLLOWUP_STATUSES)[number];

export const DEFAULT_FOLLOWUP_TITLE = "Follow up with {contact} about {deal}";
export const DEFAULT_LEAD_TITLE = "Follow up with {contact}";

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
  if (params.type === "gone_quiet" || params.type === "lead_followup" || params.stage !== deal.stageKey) return null;
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

/**
 * A lead (a contact with a lead status, decision 0022) with what the title and the safe label need. Leads whose
 * lead_status_at is missing are never loaded, so they never fire (decision 0026).
 */
export interface EngineLead {
  id: string;
  name: string;
  untrusted_fields: string;
  leadStatus: LeadStatus;
  leadStatusAt: string;
  /** The latest reach (form, email, call, meeting or a text) on the person or any of their deals, or null. */
  lastReachAt: string | null;
  archived: boolean;
}

export interface LeadFiring {
  ruleId: string;
  contactId: string;
  fireKey: string;
  title: string;
  /** The title pulled in an outside name: store it with ["title"]. */
  titleUntrusted: boolean;
  dueAt: string;
}

/** Once per rule, person and status entry: a lead that re-enters the status gets a new key. */
export const leadFireKeyOf = (ruleId: string, contactId: string, leadStatusAt: string) => `${ruleId}:${contactId}:${leadStatusAt}`;

/** Fills {contact}, the only placeholder a lead rule's title takes. */
function renderLeadTitle(template: string, lead: EngineLead): { title: string; untrusted: boolean } {
  let untrusted = false;
  const title = template.replace(/\{contact\}/g, () => {
    if (untrustedFields(lead).has("name")) untrusted = true;
    return lead.name;
  });
  return { title: title.replace(/\s+/g, " ").trim(), untrusted };
}

/**
 * When the rule catches the lead's current status entry, or null. "No contact logged" means no reach strictly after
 * the status began, so the call that moved a New lead to Contacted (logged at that same moment) doesn't count.
 */
function leadDueAt(params: RuleParams, lead: EngineLead, now: Date): number | null {
  if (params.type !== "lead_followup" || lead.archived || lead.leadStatus !== params.status) return null;
  const entered = ms(lead.leadStatusAt);
  if (params.since !== undefined && entered < ms(params.since)) return null;
  if (lead.lastReachAt !== null && ms(lead.lastReachAt) > entered) return null;
  const at = entered + params.days * DAY_MS;
  return at > now.getTime() ? null : at;
}

/**
 * The tasks the active lead_followup rules owe now, leaving out status entries already in `firedKeys`. Oldest due
 * first (then by person and rule), so a run's budget goes to the leads that have waited longest (decision 0026).
 */
export function evaluateLeadRules(input: {
  now: Date;
  rules: EngineRule[];
  leads: EngineLead[];
  firedKeys: ReadonlySet<string>;
}): LeadFiring[] {
  const firings: LeadFiring[] = [];
  for (const rule of input.rules) {
    const { params } = rule;
    if (!rule.active || params.type !== "lead_followup") continue;
    for (const lead of input.leads) {
      const fireKey = leadFireKeyOf(rule.id, lead.id, lead.leadStatusAt);
      if (input.firedKeys.has(fireKey)) continue;
      const at = leadDueAt(params, lead, input.now);
      if (at === null) continue;
      const { title, untrusted } = renderLeadTitle(params.title ?? DEFAULT_LEAD_TITLE, lead);
      firings.push({ ruleId: rule.id, contactId: lead.id, fireKey, title, titleUntrusted: untrusted, dueAt: iso(at) });
    }
  }
  return firings.sort(
    (a, b) => a.dueAt.localeCompare(b.dueAt) || a.contactId.localeCompare(b.contactId) || a.ruleId.localeCompare(b.ruleId),
  );
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
  /** A deal rule's hit names a deal; a lead_followup hit names only the person. */
  kind: "deal" | "lead";
  dealId: string | null;
  contactId: string;
  /** A safe label: outside titles and names become id labels (src/services/labels.ts). */
  label: string;
  wouldFireAt: string;
}

type Stay = { stageKey: string; from: number; to: number | null };

/** A stage_change's `data.from` and `data.to`, each null when missing or not text. */
function stageKeysOf(data: string | null): { from: string | null; to: string | null } {
  if (data === null) return { from: null, to: null };
  try {
    const value: unknown = JSON.parse(data);
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const key = (side: "from" | "to") => (typeof record[side] === "string" ? (record[side] as string) : null);
    return { from: key("from"), to: key("to") };
  } catch {
    return { from: null, to: null };
  }
}

/**
 * The deal's stays in each stage, oldest first, from its stage_change activities: the first stay starts at creation
 * in the earliest change's `from` stage (or the current stage when it never moved), and the current stay starts at
 * stage_entered_at.
 */
function stageHistory(deal: EngineDeal, changes: EngineActivity[]): Stay[] {
  const moves = changes
    .map((a) => ({ at: ms(a.occurredAt), ...stageKeysOf(a.data) }))
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
  if (params.type === "lead_followup") return [];
  const end = data.now.getTime();
  const start = end - PREVIEW_DAYS * DAY_MS;
  const hits: (PreviewHit & { dealId: string })[] = [];
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
    const own = byDeal.get(deal.id) ?? [];
    // Sorted contact times, worked out only for a deal that needs them: most deals of a stage rule never sat in its
    // stage inside the window, and skipping them keeps the preview's CPU down on a big pipeline (docs/PAID-PLAN.md).
    let sorted: number[] | undefined;
    const contacts = (): number[] =>
      (sorted ??= [...own, ...(byContact.get(deal.contact.id) ?? [])]
        .filter((a) => CONTACT_TYPES.has(a.type))
        .map((a) => ms(a.occurredAt))
        .sort((a, b) => a - b));
    const hit = (at: number) =>
      hits.push({ kind: "deal", dealId: deal.id, contactId: deal.contact.id, label: dealLabel(deal, deal.contact), wouldFireAt: iso(at) });

    if (params.type === "gone_quiet") {
      if (!isLive(deal)) continue;
      const at = firstQuietAt(ms(deal.createdAt), contacts(), params.days, start, end);
      if (at !== null) hit(at);
      continue;
    }
    const changes = own.filter((a) => a.type === "stage_change");
    for (const stay of stageHistory(deal, changes)) {
      if (stay.stageKey !== params.stage) continue;
      const left = stay.to ?? Number.POSITIVE_INFINITY;
      const at = params.type === "on_stage_enter" ? stay.from : stay.from + params.days * DAY_MS;
      if (at < start || at > end || at >= left) continue;
      if (params.type === "stage_followup" && contacts().some((c) => c > stay.from && c <= at)) continue;
      hit(at);
    }
  }
  return hits.sort((a, b) => a.wouldFireAt.localeCompare(b.wouldFireAt) || a.dealId.localeCompare(b.dealId));
}

/**
 * The leads a lead_followup rule would catch right now (decision 0026): the present, not the last 30 days, because a
 * lead's earlier statuses aren't kept. It honours the rule's `since`, and for a saved rule (`fired`) it leaves out
 * leads whose current status entry that rule already fired on. Oldest catch first.
 */
export function previewLeadRule(
  params: RuleParams,
  data: { now: Date; leads: EngineLead[]; fired?: { ruleId: string; keys: ReadonlySet<string> } },
): PreviewHit[] {
  const hits: PreviewHit[] = [];
  const { fired } = data;
  for (const lead of data.leads) {
    if (fired && fired.keys.has(leadFireKeyOf(fired.ruleId, lead.id, lead.leadStatusAt))) continue;
    const at = leadDueAt(params, lead, data.now);
    if (at === null) continue;
    hits.push({ kind: "lead", dealId: null, contactId: lead.id, label: contactName(lead), wouldFireAt: iso(at) });
  }
  return hits.sort((a, b) => a.wouldFireAt.localeCompare(b.wouldFireAt) || a.contactId.localeCompare(b.contactId));
}
