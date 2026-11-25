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
  project_statuses: "Project statuses",
  projects: "Projects",
  campaigns: "Campaigns",
  campaign_steps: "Campaign emails",
  campaign_recipients: "Campaign recipients",
  email_suppressions: "Campaign email blocks",
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

/** The campaign tables are listed only while campaigns are on; the full JSON export holds them always. */
const CAMPAIGN_TABLES: readonly ExportTable[] = ["campaigns", "campaign_steps", "campaign_recipients", "email_suppressions"];

/** The project tables are listed only while projects are on; the full JSON export holds them always. */
const PROJECT_TABLES: readonly ExportTable[] = ["project_statuses", "projects"];

export async function exportPage(ctx: PageContext): Promise<string> {
  const settings = await getSettings(ctx.db);
  const timeOn = settings.time_tracking === 1;
  const campaignsOn = settings.campaigns === 1;
  const projectsOn = settings.projects === 1;
  const shown = (table: ExportTable) =>
    (timeOn || !TIME_TABLES.includes(table)) && (campaignsOn || !CAMPAIGN_TABLES.includes(table)) && (projectsOn || !PROJECT_TABLES.includes(table));
  const links = EXPORT_TABLES.filter(shown).map(
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
