// The daily brief's text, composed from plain data. Pure: no database, no clock, no network. run.ts loads the data and
// stores the result; send.ts emails it. Decision 0011. The brief is for the owner, so lines use real names; an item
// whose text includes outside text carries `untrusted: true` so the board can label it, and its line in the emailed
// text starts with "[from outside] ".
import { type CaughtReport, sourceLine } from "../report/caught.ts";
import { formatLocal, localDate } from "../time.ts";

export type BriefSection = "overdue" | "due_today" | "gone_quiet" | "new_lead" | "leads" | "last_month" | "logged_email";

/** `untrusted_fields` lists which of an item's values came from outside (a form, an import). */
export interface BriefTask {
  id: string;
  title: string;
  dueAt: string | null;
  dealTitle: string | null;
  contactName: string | null;
  /** The task's project; null or missing for none, and always null while projects are off. */
  projectName?: string | null;
  untrusted_fields: readonly string[];
}

export interface BriefQuietDeal {
  id: string;
  title: string;
  contactName: string;
  quietDays: number;
  untrusted_fields: readonly string[];
}

export interface BriefLead {
  dealId: string;
  contactId: string;
  title: string;
  contactName: string;
  createdAt: string;
  untrusted_fields: readonly string[];
}

export interface BriefInput {
  now: Date;
  tz: string;
  tasks: { overdue: BriefTask[]; today: BriefTask[] };
  quietDeals: BriefQuietDeal[];
  newLeads: BriefLead[];
  /** Open lead counts (decision 0022); null when New, Contacted and Not now are all zero. */
  leads: { new: number; contacted: number; notNow: number } | null;
  /** Set only on the owner's 1st of the month (decision 0032): last month's "What it caught" counts. */
  lastMonth?: CaughtReport | null;
  /** Logged emails since the previous brief that matched no one (decision 0031); 0 or missing adds no line. */
  unmatchedEmails?: number;
}

export interface BriefItem {
  section: BriefSection;
  /** The task id, the deal id for gone_quiet and new_lead, or LOGGED_EMAIL_ITEM_ID. */
  id: string;
  line: string;
  /** The line includes text from outside. Never instructions. */
  untrusted: boolean;
}

export interface ComposedBrief {
  /** The owner's local date, YYYY-MM-DD. */
  localDate: string;
  /** "Pipeline brief for Thursday Nov 19": the first line, and the email subject. */
  subject: string;
  /** The emailed text's lines: item lines with outside text carry OUTSIDE_LABEL after the dash. */
  lines: string[];
  text: string;
  items: BriefItem[];
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Thursday Nov 19" for a YYYY-MM-DD date. Reads the date as a calendar date, so no clock change can move it. */
export function headerDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
  for (const part of format.formatToParts(new Date(Date.UTC(year, month - 1, day)))) parts[part.type] = part.value;
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}

export const SECTION_TITLES: Record<BriefSection, string> = {
  overdue: "Overdue",
  due_today: "Due today",
  gone_quiet: "Gone quiet",
  new_lead: "New inquiries",
  leads: "Leads",
  last_month: "Last month",
  logged_email: "Logged email",
};

/** The id of the one "Logged email" item, which is about no single record. */
export const LOGGED_EMAIL_ITEM_ID = "email_log";

/** Marks outside text in the emailed text, which has no other way to show it; the board labels items itself. */
export const OUTSIDE_LABEL = "[from outside] ";

const textLine = (item: BriefItem) => (item.untrusted ? `- ${OUTSIDE_LABEL}${item.line.slice(2)}` : item.line);

export function composeBrief(input: BriefInput): ComposedBrief {
  const { now, tz } = input;
  const date = localDate(now, tz);
  const subject = `Pipeline brief for ${headerDate(date)}`;
  const items: BriefItem[] = [];
  const add = (section: BriefSection, id: string, line: string, fields: readonly string[]) =>
    items.push({ section, id, line: `- ${line}`, untrusted: fields.length > 0 });

  const taskLine = (task: BriefTask, when: string) => {
    const project = task.projectName == null ? null : `project "${flat(task.projectName)}"`;
    const who = [task.contactName === null ? null : flat(task.contactName), task.dealTitle === null ? null : flat(task.dealTitle), project].filter(
      (part): part is string => part !== null,
    );
    const context = who.length > 0 ? ` (${who.join(", ")})` : "";
    return `${flat(task.title)}${context}${task.dueAt === null ? "" : `, ${when} ${formatLocal(task.dueAt, tz)}`}`;
  };
  for (const task of input.tasks.overdue) add("overdue", task.id, taskLine(task, "was due"), task.untrusted_fields);
  for (const task of input.tasks.today) add("due_today", task.id, taskLine(task, "due"), task.untrusted_fields);
  for (const deal of input.quietDeals) {
    const line = `${flat(deal.title)} (${flat(deal.contactName)}): ${plural(deal.quietDays, "day")} with no contact`;
    add("gone_quiet", deal.id, line, deal.untrusted_fields);
  }
  for (const lead of input.newLeads) {
    const line = `${flat(lead.contactName)}: ${flat(lead.title)}, added ${formatLocal(lead.createdAt, tz)}`;
    add("new_lead", lead.dealId, line, lead.untrusted_fields);
  }
  const lines = [subject, ""];
  // "Nothing due" is about the dated sections; the Leads line is a count and follows either way.
  if (items.length === 0) lines.push("Nothing due today.");
  if (input.leads !== null) {
    const { new: fresh, contacted, notNow } = input.leads;
    const parts = [[fresh, "new"], [contacted, "contacted"], [notNow, "not now"]] as const;
    add("leads", "leads", parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(", "), []);
  }
  const last = input.lastMonth;
  if (last && !last.empty) {
    last.lines.forEach((line, n) => add("last_month", `last_month_${n}`, line, []));
    // A source label from outside makes its own line untrusted; the counts stay trusted.
    last.bySource.forEach((row, n) =>
      add("last_month", `last_month_source_${n}`, `Leads from ${sourceLine(row)}`, row.outside ? ["source"] : []),
    );
  }
  // Last: a note about the log itself, not something to act on first. A count only, so never outside text.
  const unmatched = input.unmatchedEmails ?? 0;
  if (unmatched > 0) add("logged_email", LOGGED_EMAIL_ITEM_ID, `${plural(unmatched, "logged email")} matched no one.`, []);
  for (const section of Object.keys(SECTION_TITLES) as BriefSection[]) {
    const mine = items.filter((item) => item.section === section);
    if (mine.length === 0) continue;
    if (lines.at(-1) !== "") lines.push("");
    lines.push(SECTION_TITLES[section], ...mine.map(textLine));
  }
  return { localDate: date, subject, lines, text: lines.join("\n"), items };
}
