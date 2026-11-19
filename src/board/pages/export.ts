import { EXPORT_TABLES, type ExportTable } from "../../http/export.ts";
import { html } from "../html.ts";
import { renderPage } from "../layout.ts";

const TABLE_LABELS: Record<ExportTable, string> = {
  contacts: "Contacts",
  deals: "Deals",
  activities: "Timeline activities",
  tasks: "Tasks",
  stages: "Stages",
  field_defs: "Custom fields",
  rules: "Rules",
  rule_firings: "Rule firings",
  rulebook: "Rulebook",
  settings: "Settings",
  audit_log: "Change log",
  briefs: "Daily briefs",
};

export function exportPage(): string {
  const links = EXPORT_TABLES.map(
    (table) => html`<li><a href="/api/export/${table}.csv" download>${TABLE_LABELS[table]} (${table}.csv)</a></li>`,
  );
  return renderPage({
    title: "Export · Pipeline",
    description: "Download a full copy of your pipeline: everything as one JSON file, or one CSV file per table.",
    current: "/export",
    body: html`<h1>Export</h1>
<p class="lede">Download a copy of everything in your pipeline. Each file is made when you click, from the data as it is now.</p>
<section aria-labelledby="json-heading">
<h2 id="json-heading">Everything in one file</h2>
<p>Every table below in one JSON file, exactly as stored. Keep it as a backup or move your data elsewhere.</p>
<p><a href="/api/export.json" download>Download everything (JSON)</a></p>
</section>
<section aria-labelledby="csv-heading">
<h2 id="csv-heading">One table as a spreadsheet</h2>
<p>CSV files open in any spreadsheet app. Text that starts with =, +, -, @ or a tab gets an apostrophe in front, so a spreadsheet shows it as text instead of running it as a formula.</p>
<ul class="downloads">${links}</ul>
</section>`,
  });
}
