// The month's time CSV (decision 0051): GET /time/export.csv?month=YYYY-MM, one row per client (the entry's person) and
// work type: client, work type, hours, billable hours, rate, amount. It is the owner's own export, like /export, so names
// are written as they are, and every cell goes through the formula guard in csv.ts. Hours are the stored minutes over 60;
// amounts are summed from what each entry was saved at, never worked out again from today's rates.
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { toCents } from "../services/time-format.ts";
import { listTime, type TimeEntryView } from "../services/time-read.ts";
import { addDays, localDate } from "../time.ts";
import { toCsv } from "./csv.ts";
import { textResponse } from "./respond.ts";
import { withSecurityHeaders } from "../security.ts";

export const TIME_CSV_PATH = "/time/export.csv";

export const COLUMNS = ["client", "work type", "hours", "billable hours", "rate", "amount"] as const;

/** With projects on, a project column follows the client (ruling 10 of the projects design). */
export const PROJECT_COLUMNS = ["client", "project", "work type", "hours", "billable hours", "rate", "amount"] as const;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isMonth = (value: string): boolean => MONTH.test(value);

export const timeCsvFilename = (month: string): string => `time-${month}.csv`;

const NO_PERSON = "No person";
const NO_WORK_TYPE = "No work type";

/** The first and last local dates of a "YYYY-MM" month. */
function monthPeriod(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const year = Number(month.slice(0, 4));
  const next = Number(month.slice(5, 7)) === 12 ? `${year + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5, 7)) + 1).padStart(2, "0")}-01`;
  return { from, to: addDays(next, -1) };
}

type Group = { contactId: string | null; project: { id: string; name: string } | null; workType: string | null; minutes: number; billableMinutes: number; amount: number; rates: Set<number | null> };

const hours = (minutes: number): string => (minutes / 60).toFixed(2);

/** Real names of the people in the entries (the summary names outside ones by id). */
async function namesOf(db: Db, entries: readonly TimeEntryView[]): Promise<Map<string, string>> {
  const ids = [...new Set(entries.map((entry) => entry.contactId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const found = await db
    .prepare("SELECT id, name FROM contacts WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ id: string; name: string }>();
  return new Map(found.results.map((row) => [row.id, row.name]));
}

/** Each entry's project, in one read (a LEFT JOIN, so an entry with none is simply absent). */
async function projectsOf(db: Db, entries: readonly TimeEntryView[]): Promise<Map<string, { id: string; name: string }>> {
  if (entries.length === 0) return new Map();
  const found = await db
    .prepare(
      `SELECT te.id AS entry, p.id AS id, p.name AS name FROM time_entries te LEFT JOIN projects p ON p.id = te.project_id
       WHERE te.id IN (SELECT value FROM json_each(?)) AND p.id IS NOT NULL`,
    )
    .bind(JSON.stringify(entries.map((entry) => entry.id)))
    .all<{ entry: string; id: string; name: string }>();
  return new Map(found.results.map((row) => [row.entry, { id: row.id, name: row.name }]));
}

/** The CSV for a month, header always. The month must be "YYYY-MM" (the caller checks); time tracking must be on. */
export async function timeCsv(db: Db, month: string, tz: string): Promise<string> {
  const { entries } = await listTime(db, { period: monthPeriod(month) }, tz);
  const names = await namesOf(db, entries);
  const withProjects = (await getSettings(db)).projects === 1;
  const projects = withProjects ? await projectsOf(db, entries) : new Map<string, { id: string; name: string }>();
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const project = projects.get(entry.id) ?? null;
    const key = `${entry.contactId ?? ""}|${project?.id ?? ""}|${entry.workTypeId ?? ""}`;
    const group = groups.get(key) ?? { contactId: entry.contactId, project, workType: entry.workType, minutes: 0, billableMinutes: 0, amount: 0, rates: new Set() };
    const minutes = entry.minutes ?? 0;
    group.minutes += minutes;
    if (entry.billable) {
      group.billableMinutes += minutes;
      group.amount = toCents(group.amount + entry.amount);
      group.rates.add(entry.rate);
    }
    groups.set(key, group);
  }
  const client = (group: Group): string => (group.contactId === null ? NO_PERSON : (names.get(group.contactId) ?? group.contactId));
  const sorted = [...groups.values()].sort(
    (a, b) =>
      Number(a.contactId === null) - Number(b.contactId === null) ||
      client(a).localeCompare(client(b)) ||
      Number(a.workType === null) - Number(b.workType === null) ||
      (a.workType ?? "").localeCompare(b.workType ?? "") ||
      Number(a.project !== null) - Number(b.project !== null) ||
      (a.project?.name ?? "").localeCompare(b.project?.name ?? ""),
  );
  const rows = sorted.map((group) => {
    // One rate when every billable entry was saved at the same one; blank when they differ or none was billable.
    const [only] = group.rates.size === 1 ? [...group.rates] : [null];
    return {
      client: client(group),
      project: group.project?.name ?? "",
      "work type": group.workType ?? NO_WORK_TYPE,
      hours: hours(group.minutes),
      "billable hours": hours(group.billableMinutes),
      rate: only === null || only === undefined ? "" : only.toFixed(2),
      amount: group.amount.toFixed(2),
    };
  });
  return toCsv(rows, withProjects ? PROJECT_COLUMNS : COLUMNS);
}

/**
 * The download, or null while time tracking is off (the caller answers 404). A missing or empty month is this month; a
 * month that is not YYYY-MM is a plain 400 that does not repeat it.
 */
export async function timeCsvResponse(db: Db, query: URLSearchParams, now: Date): Promise<Response | null> {
  if ((await getSettings(db)).time_tracking !== 1) return null;
  const tz = await ownerTimezone(db);
  const asked = query.get("month") ?? "";
  const month = asked === "" ? localDate(now, tz).slice(0, 7) : asked;
  if (!isMonth(month)) return textResponse("Use a month like 2026-11, for example /time/export.csv?month=2026-11.", 400);
  return withSecurityHeaders(
    new Response(await timeCsv(db, month, tz), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${timeCsvFilename(month)}"`,
      },
    }),
  );
}
