import type { Actor, RuleType } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { listRules, type RuleView } from "../../services/rules.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { count, empty, pairs, tag, when } from "../parts.ts";

const TYPE: Record<RuleType, string> = {
  stage_followup: "Follow-up after days in a stage",
  on_stage_enter: "Task when a deal enters a stage",
  gone_quiet: "Gone quiet flag in the brief",
};

const BY: Record<string, string> = { owner: "you", ai: "your AI app", system: "the system" } satisfies Record<Actor, string>;

function ruleCard(rule: RuleView, tz: string): Html {
  return html`<li class="card">
<div class="card-head">
<h2 class="card-title">${rule.description}</h2>
${rule.active ? tag("Active") : tag("Paused", true)}
</div>
${pairs([
  { name: "Type", value: TYPE[rule.type] },
  rule.stageLabel !== null && { name: "Stage", value: rule.stageLabel },
  rule.params === null && { name: "Note", value: "Its settings can't be read, so it is skipped." },
  { name: "Fired", value: count(rule.timesFired, "time") },
  { name: "Added", value: html`${when(rule.createdAt, formatLocal(rule.createdAt, tz))} by ${BY[rule.createdBy] ?? rule.createdBy}` },
  { name: "Id", value: rule.id },
])}
</li>`;
}

export async function rulesPage(ctx: PageContext): Promise<string> {
  const { db } = ctx;
  const tz = await ownerTimezone(db);
  const rules = await listRules(db);
  return renderPage({
    title: "Rules",
    description: "Your follow-up rules: what each one does, whether it is active and how often it has fired.",
    current: "/rules",
    frame: ctx,
    body: html`<h1>Rules</h1>
<p class="lede">Active rules run every hour. To add, change, pause or resume one, ask your AI app.</p>
${
  rules.length === 0
    ? empty("No rules yet.", "Ask your AI app for one, for example a nudge three days after a proposal with no reply.")
    : html`<ul class="cards cards-wide">${rules.map((rule) => ruleCard(rule, tz))}</ul>`
}`,
  });
}
