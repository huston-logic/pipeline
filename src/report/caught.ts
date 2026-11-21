// "What it caught": the month's counts of what the rules did and what came of it (decision 0032). Pure: no database,
// no clock, no network. load.ts reads the data, the board page and the brief draw the result.
import { businessKey } from "../services/lead-change.ts";
import { monthBounds } from "./month.ts";

const DAY_MS = 86_400_000;
/** A nudge is "acted on" when the person was reached within this long after its task was made. */
export const ACTED_ON_DAYS = 7;

export interface CaughtFiring {
  ruleId: string;
  dealId: string | null;
  contactId: string | null;
  taskId: string | null;
  firedAt: string;
}

export interface CaughtInput {
  /** "YYYY-MM", read in the owner's timezone. */
  month: string;
  tz: string;
  firings: CaughtFiring[];
  /** The tasks the firings made. */
  tasks: { id: string; doneAt: string | null; createdAt: string }[];
  /** Activities that reached someone (isReach), on a deal or a person. */
  reaches: { dealId: string | null; contactId: string | null; occurredAt: string }[];
  /** The deals the firings point at, archived or not. */
  deals: { id: string; value: number | null }[];
  /** People who hold or held a lead status. `firstReachAt` is their first reach ever. */
  leads: {
    id: string;
    source: string | null;
    sourceOutside: boolean;
    createdAt: string;
    leadStatus: string;
    leadStatusAt: string | null;
    firstReachAt: string | null;
  }[];
}

export interface SourceCount {
  /** The label: the earliest spelling the owner or the AI gave, or "No source". */
  source: string;
  /** Every spelling came from outside, so the label is outside text. */
  outside: boolean;
  added: number;
  contacted: number;
  qualified: number;
}

export interface CaughtReport {
  month: string;
  rulesFired: number;
  tasksMade: number;
  actedOn: number;
  dealsTouched: number;
  valueTouched: number;
  bySource: SourceCount[];
  /** The four count lines, as the brief shows them. Source lines come from `sourceLine`. */
  lines: string[];
  /** Nothing fired and no lead was added, contacted or qualified. */
  empty: boolean;
}

const NO_SOURCE = "No source";
const numbers = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export const sourceLine = (row: SourceCount): string =>
  `${row.source}: ${row.added} added, ${row.contacted} contacted, ${row.qualified} qualified`;

function groupSources(leads: CaughtInput["leads"], inMonth: (iso: string | null) => boolean): SourceCount[] {
  type Group = { key: string; spellings: CaughtInput["leads"]; row: Omit<SourceCount, "source" | "outside"> };
  const groups = new Map<string, Group>();
  for (const lead of leads) {
    const added = inMonth(lead.createdAt);
    const contacted = inMonth(lead.firstReachAt);
    const qualified = lead.leadStatus === "qualified" && inMonth(lead.leadStatusAt);
    if (!added && !contacted && !qualified) continue;
    const key = businessKey(lead.source);
    const group = groups.get(key) ?? { key, spellings: [], row: { added: 0, contacted: 0, qualified: 0 } };
    group.spellings.push(lead);
    group.row.added += added ? 1 : 0;
    group.row.contacted += contacted ? 1 : 0;
    group.row.qualified += qualified ? 1 : 0;
    groups.set(key, group);
  }
  const earliest = (a: CaughtInput["leads"][number], b: CaughtInput["leads"][number]) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const rows = [...groups.values()].map((group): SourceCount => {
    if (group.key === "") return { source: NO_SOURCE, outside: false, ...group.row };
    const ordered = [...group.spellings].sort(earliest);
    const chosen = ordered.find((lead) => !lead.sourceOutside) ?? ordered[0];
    return { source: (chosen?.source ?? "").trim(), outside: chosen?.sourceOutside ?? false, ...group.row };
  });
  const total = (row: SourceCount) => row.added + row.contacted + row.qualified;
  return rows.sort(
    (a, b) =>
      Number(a.source === NO_SOURCE) - Number(b.source === NO_SOURCE) ||
      total(b) - total(a) ||
      a.source.localeCompare(b.source),
  );
}

export function composeCaught(input: CaughtInput): CaughtReport {
  const { start, end } = monthBounds(input.month, input.tz);
  const inMonth = (iso: string | null) => iso !== null && Date.parse(iso) >= start.getTime() && Date.parse(iso) < end.getTime();

  const firings = input.firings.filter((firing) => inMonth(firing.firedAt));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const reachTimes = (key: "dealId" | "contactId") => {
    const byId = new Map<string, number[]>();
    for (const reach of input.reaches) {
      const id = reach[key];
      if (id !== null) byId.set(id, [...(byId.get(id) ?? []), Date.parse(reach.occurredAt)]);
    }
    return byId;
  };
  const byDeal = reachTimes("dealId");
  const byContact = reachTimes("contactId");

  let tasksMade = 0;
  let actedOn = 0;
  const touched = new Set<string>();
  for (const firing of firings) {
    const task = firing.taskId === null ? undefined : tasks.get(firing.taskId);
    if (!task) continue;
    tasksMade += 1;
    const from = Date.parse(task.createdAt);
    const to = from + ACTED_ON_DAYS * DAY_MS;
    const reached = [...(byDeal.get(firing.dealId ?? "") ?? []), ...(byContact.get(firing.contactId ?? "") ?? [])].some(
      (time) => time >= from && time <= to,
    );
    if (task.doneAt === null && !reached) continue;
    actedOn += 1;
    if (firing.dealId !== null) touched.add(firing.dealId);
  }
  const values = new Map(input.deals.map((deal) => [deal.id, deal.value ?? 0]));
  const valueTouched = [...touched].reduce((sum, id) => sum + (values.get(id) ?? 0), 0);

  const bySource = groupSources(input.leads, inMonth);
  const lines = [
    `Rules fired: ${firings.length}`,
    `Tasks made: ${tasksMade}`,
    `Acted on within ${ACTED_ON_DAYS} days: ${actedOn} of ${tasksMade}`,
    `Deals touched after a nudge: ${touched.size}, worth ${numbers.format(valueTouched)}`,
  ];
  return {
    month: input.month,
    rulesFired: firings.length,
    tasksMade,
    actedOn,
    dealsTouched: touched.size,
    valueTouched,
    bySource,
    lines,
    empty: firings.length === 0 && bySource.length === 0,
  };
}
