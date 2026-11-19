import type { Actor, Db, RuleType } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { listRules, type RuleView } from "../../services/rules.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { count, empty, fact, meta, when } from "../parts.ts";

const TYPE: Record<RuleType, string> = {
  stage_followup: "Follow-up after days in a stage",
  on_stage_enter: "Task when a deal enters a stage",
  gone_quiet: "Gone quiet flag in the brief",
};

const BY: Record<string, string> = { owner: "you", ai: "your AI app", system: "the system" } satisfies Record<Actor, string>;

function ruleItem(rule: RuleView, tz: string): Html {
  return html`<li>
<p class="item-title">${rule.description}</p>
${meta([
  fact("Status", rule.active ? "Active" : html`<span class="flag">Paused</span>`),
  fact("Type", TYPE[rule.type]),
  rule.stageLabel !== null && fact("Stage", rule.stageLabel),
  rule.params === null && fact("Note", "its settings can't be read, so it is skipped"),
  fact("Fired", count(rule.timesFired, "time")),
  fact("Added", html`${when(rule.createdAt, formatLocal(rule.createdAt, tz))} by ${BY[rule.createdBy] ?? rule.createdBy}`),
  fact("Id", rule.id),
])}
</li>`;
}

export async function rulesPage(db: Db): Promise<string> {
  const tz = await ownerTimezone(db);
  const rules = await listRules(db);
  return renderPage({
    title: "Rules · Pipeline",
    description: "Your follow-up rules: what each one does, whether it is active and how often it has fired.",
    current: "/rules",
    body: html`<h1>Rules</h1>
<p class="lede">Active rules run every hour. To add, change, pause or resume one, ask your AI app.</p>
${
  rules.length === 0
    ? empty("No rules yet. Ask your AI app for one, for example a nudge three days after a proposal with no reply.")
    : html`<ul class="items">${rules.map((rule) => ruleItem(rule, tz))}</ul>`
}`,
  });
}
