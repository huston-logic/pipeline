// Time tools (decision 0049). The four record ones (start_timer, stop_timer, add_time_entry, update_time_entry) go
// through recordWrite like every record tool: a proposal under Review first, applied at once under Apply small for a
// start, and a stop with no next step. Work types and client rates are configuration (server rule 5: only when the
// owner asks) and write at once. list_time and list_work_types are reads. Every one refuses while time tracking is off.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { UserError } from "../services/errors.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { addTimeEntryInput, startTimerInput, stopTimerInput, updateTimeEntryInput } from "../services/record-inputs.ts";
import { requireTimeTracking } from "../services/settings.ts";
import { formatDuration, formatMoney } from "../services/time-format.ts";
import { runningTimer } from "../services/time-entries.ts";
import { checkPeriod, entryViews, listTime, type Period, PERIOD_NAMES, type PeriodName, periodOf } from "../services/time-read.ts";
import { addWorkType, listWorkTypes, setClientRate, updateWorkType } from "../services/work-types.ts";
import { addDays, formatLocal, zonedToUtc } from "../time.ts";
import { toolResult } from "./format.ts";
import { recordWrite } from "./record-write.ts";
import { orNull, shortText } from "./schemas.ts";
import { aiCtx, registerTool, type ToolDeps } from "./tool.ts";
import { PROPOSES } from "./tools-write.ts";

/** At most this many entries come back; the totals always cover the whole period. */
const ENTRIES_MAX = 200;
const RANGE_MAX_DAYS = 366;

const PERIOD_WORDS: Record<PeriodName, string> = {
  this_week: "this week",
  last_week: "last week",
  this_month: "this month",
  last_month: "last month",
};

const localDay = (date: string, tz: string) => formatLocal(zonedToUtc(`${date}T12:00`, tz), tz).split(",")[0] ?? date;

const date = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what}, YYYY-MM-DD in the owner's timezone.`);

const rate = (what: string) => z.number().min(0).max(100_000).describe(what);

/** The period list_time reads: a named one (this week by default), or from and to. */
function periodFrom(args: { period?: PeriodName; from?: string; to?: string }, now: Date, tz: string): { period: Period; words: string } {
  if (args.period !== undefined && (args.from !== undefined || args.to !== undefined)) throw new UserError("Give a period or from and to, not both.");
  if (args.from === undefined && args.to === undefined) {
    const name = args.period ?? "this_week";
    const period = periodOf(name, now, tz);
    return { period, words: `${PERIOD_WORDS[name]} (${localDay(period.from, tz)} to ${localDay(period.to, tz)})` };
  }
  if (args.from === undefined || args.to === undefined) throw new UserError("Give both from and to (YYYY-MM-DD), or a period.");
  const period = checkPeriod({ from: args.from, to: args.to });
  if (period.from <= period.to && addDays(period.from, RANGE_MAX_DAYS - 1) < period.to) {
    throw new UserError(`A range can be at most ${RANGE_MAX_DAYS} days. Ask for a shorter one.`);
  }
  return { period, words: `from ${localDay(period.from, tz)} to ${localDay(period.to, tz)}` };
}

export function registerTimeTools(server: McpServer, deps: ToolDeps): void {
  registerTool(
    server,
    {
      name: "start_timer",
      title: "Start the timer",
      kind: "write",
      description:
        "Starts the timer now, for a person, a deal (and so its person), a task, or nothing, with an optional work type. " +
        "Only one timer runs at a time: a second start is refused. Stop it with stop_timer. " +
        PROPOSES,
      input: startTimerInput,
      run: (args, deps) => recordWrite(deps, { action: "start_timer", ...args }),
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "stop_timer",
      title: "Stop the timer",
      kind: "write",
      description:
        "Stops the running timer and saves it as a time entry, with its minutes (rounded up) and, when billable, the " +
        "rate used. Notes are kept on the entry and logged as a note on its person or deal; nextStepDate adds the task " +
        "\"Next step\" due then. A timer left running over 16 hours needs its real startedAt or endedAt. " +
        PROPOSES,
      input: stopTimerInput,
      run: (args, deps) => recordWrite(deps, { action: "stop_timer", ...args }),
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_time_entry",
      title: "Add a time entry",
      kind: "write",
      description:
        "Adds time already worked: a start, and an end or minutes (1 to 960, 16 hours), for a person, a deal, a task or " +
        "nothing, with an optional work type. Billable entries keep the rate of the moment: the person's own rate for " +
        "the work type, else the work type's. " +
        PROPOSES,
      input: addTimeEntryInput,
      run: (args, deps) => recordWrite(deps, { action: "add_time_entry", ...args }),
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_time_entry",
      title: "Update a time entry",
      kind: "write",
      destructive: true,
      idempotent: true,
      description:
        "Changes a time entry: its start (the end stays), end or minutes, person, deal or task, work type, billable or " +
        "notes, or archives it (archived true; nothing is ever deleted). Changing the work type, person or billable " +
        "works the rate out again from today's rates. Give only what changes; find the id with list_time. " +
        PROPOSES,
      input: updateTimeEntryInput,
      run: (args, deps) => recordWrite(deps, { action: "update_time_entry", ...args }),
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_time",
      title: "List time",
      kind: "read",
      description:
        "Time entries that started in a period (this_week by default; weeks start on Monday; or from and to, local " +
        "dates), oldest first, with totals: all time, billable time and its amount, by person and by deal. Filters: " +
        `contact, deal (id or name). At most ${ENTRIES_MAX} entries come back; the totals cover them all. Also says ` +
        "which timer is running.",
      input: z.strictObject({
        period: z.enum(PERIOD_NAMES).optional().describe("this_week (the default), last_week, this_month or last_month."),
        from: date("The first day").optional(),
        to: date("The last day, included").optional(),
        contact: shortText("Only this person's time: id or exact name.").optional(),
        deal: shortText("Only this deal's time: id or title.").optional(),
      }),
      async run(args, { db, now }) {
        await requireTimeTracking(db);
        const tz = await ownerTimezone(db);
        const { period, words } = periodFrom(args, now(), tz);
        const summary = await listTime(db, { period, contact: args.contact, deal: args.deal }, tz);
        const running = await runningTimer(db);
        const headline =
          summary.totalMinutes === 0
            ? `No time ${words}.`
            : `${formatDuration(summary.totalMinutes)} ${words}: ` +
              (summary.billableMinutes === 0
                ? "none billable."
                : `${formatDuration(summary.billableMinutes)} billable, ${formatMoney(summary.billableAmount)}.`);
        return toolResult(headline, {
          period,
          totalMinutes: summary.totalMinutes,
          billableMinutes: summary.billableMinutes,
          billableAmount: summary.billableAmount,
          byPerson: summary.byPerson,
          byDeal: summary.byDeal,
          entries: summary.entries.slice(0, ENTRIES_MAX),
          running: running === null ? null : ((await entryViews(db, [running]))[0] ?? null),
        });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_work_types",
      title: "List work types",
      kind: "read",
      description: "The work types in order, each with its hourly rate, whether it is billable by default, and the people with a rate of their own for it.",
      input: z.strictObject({}),
      async run(_args, { db }) {
        const workTypes = await listWorkTypes(db);
        const n = workTypes.length;
        const headline = n === 0 ? "No work types yet. Add one with add_work_type when the owner asks." : `${n} work type${n === 1 ? "" : "s"}.`;
        return toolResult(headline, { workTypes });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_work_type",
      title: "Add a work type",
      kind: "write",
      description:
        "Adds a kind of work the owner bills or tracks, for example Design, with an optional hourly rate and whether it " +
        "is billable by default (true unless given). Names are unique. Only when the owner asks.",
      input: z.strictObject({
        name: shortText("The work type's name, for example \"Design\" (up to 60 characters)."),
        hourlyRate: orNull(rate("Its hourly rate, 0 to 100,000, or null for none.")).optional(),
        billableDefault: z.boolean().optional().describe("false when its time is usually not billed (the default is true)."),
      }),
      async run(args, deps) {
        const result = await addWorkType(aiCtx(deps, "add_work_type"), args);
        return toolResult(result.summary, { changeId: result.changeId, workTypeId: result.workTypeId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_work_type",
      title: "Update a work type",
      kind: "write",
      destructive: true,
      idempotent: true,
      description:
        "Renames a work type, changes its hourly rate or billable default, or archives or restores it. A new rate is " +
        "used from now on; time already saved keeps the rate it had. Only when the owner asks.",
      input: z.strictObject({
        workType: shortText("The work type: its name or id."),
        name: shortText("The new name.").optional(),
        hourlyRate: orNull(rate("The new hourly rate, or null for none.")).optional(),
        billableDefault: z.boolean().optional().describe("Whether its time is billable by default."),
        archived: z.boolean().optional().describe("true to archive it, false to bring it back."),
      }),
      async run({ workType, ...patch }, deps) {
        const result = await updateWorkType(aiCtx(deps, "update_work_type"), workType, patch);
        return toolResult(result.summary, { changeId: result.changeId, workTypeId: result.workTypeId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "set_client_rate",
      title: "Set a client's rate",
      kind: "write",
      destructive: true,
      idempotent: true,
      description:
        "Sets one person's own hourly rate for a work type, which beats the work type's rate for their time from now on; " +
        "null clears it. Time already saved keeps its rate. Only when the owner asks.",
      input: z.strictObject({
        workType: shortText("The work type: its name or id."),
        contact: shortText("The person: their id (ct_...) or exact name."),
        hourlyRate: z.number().min(0).max(100_000).nullable().describe("Their hourly rate, or null to clear it."),
      }),
      async run(args, deps) {
        const result = await setClientRate(aiCtx(deps, "set_client_rate"), args);
        return toolResult(result.summary, { changeId: result.changeId });
      },
    },
    deps,
  );
}
