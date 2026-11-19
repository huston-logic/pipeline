// Read tools (annotated readOnlyHint: true). They never write. Headlines use counts, ids, dates and owner-set stage
// labels only; names, titles and every other value are in the JSON below the headline.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRulebook } from "../db/queries.ts";
import { UserError } from "../services/errors.ts";
import { fieldOverview } from "../services/fields.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { getSettings } from "../services/settings.ts";
import { stageOverview } from "../services/stages.ts";
import { getDealBrief, listDealsFiltered, pipelineSummary, recentChanges, searchContacts, whatsDue } from "../services/read.ts";
import { listRules, previewRuleFor } from "../services/rules.ts";
import { formatLocal, parseWhen } from "../time.ts";
import { toolResult } from "./format.ts";
import { DEAL_STATUSES, dealRef, FIELD_ENTITIES, RULE_TYPES, ruleRef, ruleSettings, shortText, when } from "./schemas.ts";
import { registerTool, type ToolDeps } from "./tool.ts";

const DAY_MS = 86_400_000;

/** "1 open deal", "3 open deals". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  registerTool(
    server,
    {
      name: "pipeline_summary",
      title: "Pipeline summary",
      kind: "read",
      description:
        "The whole pipeline at a glance: every open stage with its deals, count and total value, plus how many deals " +
        "are won, lost or not now. Use it for \"What's in my pipeline?\".",
      input: z.strictObject({}),
      async run(_args, { db, now }) {
        const at = now();
        const summary = await pipelineSummary(db, at, await ownerTimezone(db));
        if (summary.total === 0) return toolResult("Your pipeline is empty: there are no deals yet. Add one with add_lead.", summary);
        const { open, closed } = summary;
        return toolResult(
          `${count(open.count, "open deal")} (total value ${open.value}) across ${count(summary.stages.length, "open stage")}; ` +
            `${closed.won} won, ${closed.lost} lost, ${closed.not_now} not now.`,
          summary,
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_deals",
      title: "List deals",
      kind: "read",
      description:
        "Deals that are not archived, in board order (stage, then longest in the stage first). Every filter is optional " +
        "and they combine. Without filters it lists every deal, open and closed.",
      input: z.strictObject({
        stage: shortText("Only deals in this stage: its key (call_booked) or label (Call booked).").optional(),
        status: z.enum(DEAL_STATUSES).optional().describe("Only deals with this status."),
        due: z
          .enum(["overdue", "today", "week"])
          .optional()
          .describe("By next date: before today, today, or from today through the next six days (owner's timezone)."),
        quiet: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Gone quiet: no logged contact for at least this many days. Open deals only unless a status is given."),
      }),
      async run(args, { db, now }) {
        const deals = await listDealsFiltered(db, args, now(), await ownerTimezone(db));
        const filtered = Object.keys(args).length > 0;
        const headline =
          deals.length > 0
            ? `${count(deals.length, "deal")} ${filtered ? "found" : "in the pipeline"}.`
            : filtered
              ? "No deals match those filters."
              : "Your pipeline is empty: there are no deals yet. Add one with add_lead.";
        return toolResult(headline, { filter: args, deals });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "get_deal",
      title: "Deal brief",
      kind: "read",
      description:
        "A pre-call brief on one deal: the deal, its contact, the timeline (newest first), open tasks and the next step. " +
        "Use it for \"Tell me everything about <name> before our call\".",
      input: z.strictObject({ deal: dealRef() }),
      async run({ deal }, { db, now }) {
        const brief = await getDealBrief(db, deal, await ownerTimezone(db), now());
        const next = brief.next.step !== null || brief.next.at !== null ? "a next step is set" : "no next step yet";
        return toolResult(
          `Deal ${brief.deal.id} is in ${brief.stage.label}: ${count(brief.timeline.length, "timeline entry", "timeline entries")}, ` +
            `${count(brief.openTasks.length, "open task")}, ${next}.`,
          brief,
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "search_contacts",
      title: "Search contacts",
      kind: "read",
      description:
        "Contacts whose name, email, business or phone contains the text (up to 20, by name), each with their deals. " +
        "An empty query lists the first 20 contacts.",
      input: z.strictObject({ query: z.string().max(200).describe("Text to look for, for example part of a name.") }),
      async run({ query }, { db }) {
        const contacts = await searchContacts(db, query);
        const headline =
          contacts.length === 0
            ? query.trim() === ""
              ? "There are no contacts yet. Add one with add_lead."
              : "No contacts match that search."
            : `${count(contacts.length, "contact")} found.`;
        return toolResult(headline, { query, contacts });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "whats_due",
      title: "What's due",
      kind: "read",
      description:
        "Who needs a follow-up: open tasks due today or overdue (snoozed ones left out) and open deals whose next date " +
        "is today or past, in the owner's timezone.",
      input: z.strictObject({}),
      async run(_args, { db, now }) {
        const due = await whatsDue(db, now(), await ownerTimezone(db));
        const total = due.overdueTasks.length + due.todayTasks.length + due.overdueDeals.length + due.todayDeals.length;
        const headline =
          total === 0
            ? `Nothing is due today (${due.today}) and nothing is overdue.`
            : `Due by the end of today (${due.today}): ${count(due.overdueTasks.length, "overdue task")}, ` +
              `${count(due.todayTasks.length, "task")} due today, ${count(due.overdueDeals.length, "overdue deal")}, ` +
              `${count(due.todayDeals.length, "deal")} with a next step today.`;
        return toolResult(headline, due);
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "recent_changes",
      title: "Recent changes",
      kind: "read",
      description:
        "The change log, newest first (up to 100): every write with its change id, who made it and whether it was undone. " +
        "Use a change id with undo_change.",
      input: z.strictObject({ since: when("Only changes at or after this time; the default is 7 days ago").optional() }),
      async run({ since }, { db, now }) {
        const tz = await ownerTimezone(db);
        const from = since === undefined ? new Date(now().getTime() - 7 * DAY_MS) : parseWhen(since, tz);
        const changes = await recentChanges(db, from);
        const fromText = formatLocal(from, tz);
        const headline =
          changes.length === 0
            ? `No changes since ${fromText}.`
            : `${count(changes.length, "change")} since ${fromText}, newest first${changes.length >= 100 ? " (the latest 100)" : ""}.`;
        return toolResult(headline, { since: from.toISOString(), changes });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "get_rulebook",
      title: "Read the rulebook",
      kind: "read",
      description:
        "The owner's rulebook: named markdown documents (voice, pipeline, guardrails) that say how to write and how to " +
        "run the pipeline. Read it before the first write in a conversation.",
      input: z.strictObject({ name: shortText("One document's name; leave it out for every document.").optional() }),
      async run({ name }, { db }) {
        const documents = (await getRulebook(db, name?.trim())).map((doc) => ({
          name: doc.name,
          markdown: doc.markdown,
          updatedAt: doc.updated_at,
        }));
        if (name !== undefined && documents.length === 0) {
          const names = (await getRulebook(db)).map((doc) => doc.name);
          const list = names.length > 0 ? ` Documents: ${names.join(", ")}.` : " The rulebook is empty.";
          throw new UserError(`There's no rulebook document "${name.trim()}".${list} Leave the name out to read them all.`);
        }
        const headline =
          documents.length === 0
            ? "The rulebook is empty."
            : `Rulebook: ${count(documents.length, "document")} (${documents.map((doc) => doc.name).join(", ")}).`;
        return toolResult(headline, { documents });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_stages",
      title: "List stages",
      kind: "read",
      description:
        "The pipeline's stages in board order, each with its key, label, position, kind (open, won, lost, not_now) and " +
        "how many open deals sit in it. Archived stages are left out unless asked for.",
      input: z.strictObject({
        includeArchived: z.boolean().optional().describe("true to list archived stages too."),
      }),
      async run({ includeArchived }, { db }) {
        const stages = await stageOverview(db, includeArchived === true);
        const labels = stages.map((s) => `${s.label}${s.archived ? " (archived)" : ""}`);
        return toolResult(
          stages.length === 0
            ? "There are no stages. Add one with add_stage."
            : `${count(stages.length, "stage")} in board order: ${labels.join(", ")}.`,
          { stages },
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_fields",
      title: "List custom fields",
      kind: "read",
      description:
        "The owner's custom fields on contacts and deals: id, key, label, type (text, number, date, choice) and the " +
        "choices of a choice field. Use the keys when setting field values. Archived fields are left out unless asked for.",
      input: z.strictObject({
        entity: z.enum(FIELD_ENTITIES).optional().describe("Only fields of this kind of record."),
        includeArchived: z.boolean().optional().describe("true to list archived fields too."),
      }),
      async run({ entity, includeArchived }, { db }) {
        const fields = await fieldOverview(db, { entity, includeArchived });
        const of = (kind: string) => fields.filter((f) => f.entity === kind).length;
        return toolResult(
          fields.length === 0
            ? "There are no custom fields yet. Add one with add_field."
            : `${count(of("deal"), "deal field")} and ${count(of("contact"), "contact field")}.`,
          { fields },
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "list_rules",
      title: "List rules",
      kind: "read",
      description:
        "The owner's rules, oldest first: each one's id, type, plain-English description, whether it is active or " +
        "paused, its parameters, the stage it watches and how many times it has fired. Rules are paused, never deleted.",
      input: z.strictObject({}),
      async run(_args, { db }) {
        const rules = await listRules(db);
        const active = rules.filter((rule) => rule.active).length;
        return toolResult(
          rules.length === 0
            ? "There are no rules yet. Preview one with preview_rule, then add it with add_rule."
            : `${count(rules.length, "rule")}: ${active} active, ${rules.length - active} paused.`,
          { rules },
        );
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "preview_rule",
      title: "Preview a rule",
      kind: "read",
      description:
        "Says which deals a rule would have caught in the last 30 days, and when, without changing anything. Give a " +
        "saved rule's id, or a new rule's type and settings (the same as add_rule). Preview a new rule before adding it.",
      input: z.strictObject({
        rule: ruleRef().optional(),
        type: z.enum(RULE_TYPES).optional().describe("A new rule's type (leave out when previewing a saved rule)."),
        ...ruleSettings,
      }),
      async run(args, { db, now }) {
        const preview = await previewRuleFor(db, now(), args);
        const times = preview.hits.length;
        const headline =
          times === 0
            ? "This rule would not have caught any deal in the last 30 days. Nothing was changed."
            : `This rule would have caught ${count(preview.dealCount, "deal")} in the last 30 days ` +
              `(${count(times, "time")}). Nothing was changed.`;
        return toolResult(headline, preview);
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "get_settings",
      title: "Read the settings",
      kind: "read",
      description:
        "The owner's settings: timezone, the daily brief's hour, address and on/off switch, when the last brief was " +
        "composed and when one last went out by email, the board's business name and accent colour (null means the " +
        "defaults), and the owner emails that may sign in (shown here, never changeable through this server; the " +
        "brief address must be one of them).",
      input: z.strictObject({}),
      async run(_args, { db }) {
        const settings = await getSettings(db);
        const hour = settings.briefHour;
        const at = `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`;
        return toolResult(
          `Timezone ${settings.timezone}; the daily brief is ${settings.briefEnabled ? "on" : "off"} (${at}).`,
          settings,
        );
      },
    },
    deps,
  );
}
