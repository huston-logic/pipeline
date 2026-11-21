// Reads what composeCaught needs for one month, in a fixed number of statements (five) however much data there is, with
// bound values only (decision 0032). Reaches are read for the month and the 7 days after it, only for the deals and
// people the month's rules fired on, so a big activity log is not pulled in.
import type { Db } from "../db/db.ts";
import { untrustedFields } from "../services/labels.ts";
import { REACH_SQL } from "../services/rules.ts";
import { ACTED_ON_DAYS, type CaughtInput } from "./caught.ts";
import { monthBounds } from "./month.ts";

const DAY_MS = 86_400_000;

type FiringRow = { rule_id: string; deal_id: string | null; contact_id: string | null; task_id: string | null; fired_at: string };
type TaskRow = { id: string; done_at: string | null; created_at: string };
type ReachRow = { deal_id: string | null; contact_id: string | null; occurred_at: string };
type DealRow = { id: string; value: number | null };
type LeadRow = {
  id: string;
  source: string | null;
  untrusted_fields: string;
  created_at: string;
  lead_status: string;
  lead_status_at: string | null;
  first_reach: string | null;
};

const FIRED_IN_MONTH = "fired_at >= ? AND fired_at < ?";

export async function loadCaughtInput(db: Db, month: string, tz: string): Promise<CaughtInput> {
  const { start, end } = monthBounds(month, tz);
  const from = start.toISOString();
  const to = end.toISOString();
  const reachUntil = new Date(end.getTime() + ACTED_ON_DAYS * DAY_MS).toISOString();

  const firings = await db
    .prepare(`SELECT rule_id, deal_id, contact_id, task_id, fired_at FROM rule_firings WHERE ${FIRED_IN_MONTH} ORDER BY fired_at, id`)
    .bind(from, to)
    .all<FiringRow>();
  const tasks = await db
    .prepare(`SELECT id, done_at, created_at FROM tasks WHERE id IN (SELECT task_id FROM rule_firings WHERE ${FIRED_IN_MONTH})`)
    .bind(from, to)
    .all<TaskRow>();
  const reaches = await db
    .prepare(
      `SELECT a.deal_id, a.contact_id, a.occurred_at FROM activities a
       WHERE a.occurred_at >= ? AND a.occurred_at <= ? AND ${REACH_SQL}
         AND (a.deal_id IN (SELECT deal_id FROM rule_firings WHERE ${FIRED_IN_MONTH})
           OR a.contact_id IN (SELECT contact_id FROM rule_firings WHERE ${FIRED_IN_MONTH}))`,
    )
    .bind(from, reachUntil, from, to, from, to)
    .all<ReachRow>();
  const deals = await db
    .prepare(`SELECT id, value FROM deals WHERE id IN (SELECT deal_id FROM rule_firings WHERE ${FIRED_IN_MONTH})`)
    .bind(from, to)
    .all<DealRow>();
  // People who hold or held a lead status. Their first reach ever is read only for those that did something in the month.
  const leads = await db
    .prepare(
      `SELECT * FROM (
         SELECT c.id, c.source, c.untrusted_fields, c.created_at, c.lead_status, c.lead_status_at,
           (SELECT MIN(a.occurred_at) FROM activities a WHERE a.contact_id = c.id AND ${REACH_SQL}) AS first_reach
         FROM contacts c WHERE c.lead_status IS NOT NULL
       ) WHERE (created_at >= ? AND created_at < ?)
         OR (lead_status = 'qualified' AND lead_status_at >= ? AND lead_status_at < ?)
         OR (first_reach >= ? AND first_reach < ?)`,
    )
    .bind(from, to, from, to, from, to)
    .all<LeadRow>();

  return {
    month,
    tz,
    firings: firings.results.map((row) => ({
      ruleId: row.rule_id,
      dealId: row.deal_id,
      contactId: row.contact_id,
      taskId: row.task_id,
      firedAt: row.fired_at,
    })),
    tasks: tasks.results.map((row) => ({ id: row.id, doneAt: row.done_at, createdAt: row.created_at })),
    reaches: reaches.results.map((row) => ({ dealId: row.deal_id, contactId: row.contact_id, occurredAt: row.occurred_at })),
    deals: deals.results,
    leads: leads.results.map((row) => ({
      id: row.id,
      source: row.source,
      sourceOutside: untrustedFields({ untrusted_fields: row.untrusted_fields }).has("source"),
      createdAt: row.created_at,
      leadStatus: row.lead_status,
      leadStatusAt: row.lead_status_at,
      firstReachAt: row.first_reach,
    })),
  };
}
