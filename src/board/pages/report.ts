// /report, "What it caught" (decision 0032): last month by default, what the rules did and what came of it, and the
// leads added, contacted and qualified by source. The month is the only thing taken from the URL and is checked against
// a fixed list before it is used or drawn; nothing from a record goes into a link.
import { ACTED_ON_DAYS, composeCaught, type SourceCount } from "../../report/caught.ts";
import { loadCaughtInput } from "../../report/load.ts";
import { addMonths, monthLabel, reportMonth } from "../../report/month.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { empty, formatNumber, labelled, pairs, section } from "../parts.ts";

export const REPORT_PATH = "/report";

const monthHref = (month: string) => `${REPORT_PATH}?month=${month}`;

/** Previous and Next month links, each only when that month can be shown. */
function monthSwitch(month: string, now: Date, tz: string): Html | "" {
  const link = (target: string, word: string) =>
    reportMonth(target, now, tz) === target ? html`<li><a href="${monthHref(target)}">${word} month (${monthLabel(target)})</a></li>` : "";
  const previous = link(addMonths(month, -1), "Previous");
  const next = link(addMonths(month, 1), "Next");
  if (previous === "" && next === "") return "";
  return html`<ul class="view-switch" aria-label="Choose a month">${previous}${next}</ul>`;
}

const sourceRow = (row: SourceCount): Html =>
  html`<li>${labelled(row.source, row.outside)}: ${row.added} added, ${row.contacted} contacted, ${row.qualified} qualified</li>`;

export async function reportPage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const month = reportMonth(ctx.query.get("month"), now, tz);
  const label = monthLabel(month);
  const report = composeCaught(await loadCaughtInput(db, month, tz));

  const body = report.empty
    ? empty(`Nothing to report for ${label}.`, "A month fills in once a rule fires or a lead is added.")
    : html`${section(
        "caught-rules",
        "Rules and tasks",
        html`<div class="panel">${pairs([
          { name: "Rules fired", value: String(report.rulesFired) },
          { name: "Tasks made", value: String(report.tasksMade) },
          { name: `Acted on within ${ACTED_ON_DAYS} days`, value: `${report.actedOn} of ${report.tasksMade}` },
          {
            name: "Deals touched after a nudge",
            value: report.dealsTouched === 0 ? "0" : `${report.dealsTouched}, worth ${formatNumber(report.valueTouched)}`,
          },
        ])}</div>
<p class="section-note">Acted on means the task was completed, or a call, email, meeting, text or form was logged on that deal or person within ${ACTED_ON_DAYS} days of the task being made.</p>`,
      )}
${section(
  "caught-leads",
  "Leads by source",
  report.bySource.length === 0
    ? html`<p class="section-note">No leads were added, contacted or qualified.</p>`
    : html`<ul class="panel rows">${report.bySource.map(sourceRow)}</ul>`,
)}`;

  return renderPage({
    title: "What it caught",
    description: "A monthly look at what your rules did: rules fired, tasks made, how many were acted on, and leads by source.",
    current: REPORT_PATH,
    frame: ctx,
    body: html`<h1>What it caught</h1>
<p class="lede">For ${label}. What your rules did, and what came of it.</p>
${monthSwitch(month, now, tz)}
${body}`,
  });
}
