import { EXPORT_TABLES, type ExportTable } from "../../http/export.ts";
import { html } from "../html.ts";
import { icon } from "../icons.ts";
import type { PageContext } from "../context.ts";
import { getSettings } from "../../db/queries.ts";
import { renderPage } from "../layout.ts";

const TABLE_LABELS: Record<ExportTable, string> = {
  contacts: "Contacts",
  deals: "Deals",
  activities: "Timeline activities",
  tasks: "Tasks",
  time_entries: "Time entries",
  work_types: "Work types",
  client_rates: "Client rates",
  stages: "Stages",
  field_defs: "Custom fields",
  rules: "Rules",
  person_statuses: "Person statuses",
  person_substatuses: "Sub-statuses",
  views: "Saved views",
  rule_firings: "Rule firings",
  rulebook: "Rulebook",
  settings: "Settings",
  audit_log: "Change log",
  audit_parts: "Change log, big changes",
  briefs: "Daily briefs",
  email_log: "Logged emails",
};

/** The tables that only matter while time tracking is on (decision 0051); the full JSON export still holds them. */
const TIME_TABLES: readonly ExportTable[] = ["time_entries", "work_types", "client_rates"];

export async function exportPage(ctx: PageContext): Promise<string> {
  const timeOn = (await getSettings(ctx.db)).time_tracking === 1;
  const links = EXPORT_TABLES.filter((table) => timeOn || !TIME_TABLES.includes(table)).map(
    (table) =>
      html`<li><a class="download-row" href="/api/export/${table}.csv" download>${icon("export")}<span class="download-label">${TABLE_LABELS[table]}</span> <span class="download-file">${table}.csv</span></a></li>`,
  );
  return renderPage({
    title: "Export",
    description: "Download a full copy of your pipeline: everything as one JSON file, or one CSV file per table.",
    current: "/export",
    frame: ctx,
    body: html`<h1>Export</h1>
<p class="lede">Download a copy of everything in your pipeline. Each file is made when you click, from the data as it is now.</p>
<section aria-labelledby="json-heading">
<h2 id="json-heading">Everything in one file</h2>
<div class="card">
<p>Every table below in one JSON file, exactly as stored. Keep it as a backup or move your data elsewhere.</p>
<p class="card-actions"><a class="button" href="/api/export.json" download>${icon("export")}Download everything (JSON)</a></p>
</div>
</section>
<section aria-labelledby="csv-heading">
<h2 id="csv-heading">One table as a spreadsheet</h2>
<p class="section-note">CSV files open in any spreadsheet app. Text that starts with =, +, -, @ or a tab gets an apostrophe in front, so a spreadsheet shows it as text instead of running it as a formula.</p>
<ul class="panel rows downloads">${links}</ul>
</section>`,
  });
}
