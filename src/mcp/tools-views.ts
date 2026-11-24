// The saved view tools (decision 0042): list_views (read-only), add_view, update_view and archive_view (each one
// audited change, actor ai). They call src/services/views.ts only. Filters are camelCase here, like every tool input;
// the service checks each one against the copy and stores keys.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ALL_SORT_KEYS, MAX_COLUMNS, MAX_FILTER_FIELDS, MAX_FILTER_TEXT, VIEW_COLUMNS, VIEW_LAYOUTS, VIEW_MODULES, VIEW_SORTS } from "../services/view-spec.ts";
import { addView, archiveView, listViews, updateView } from "../services/views.ts";
import { toolResult } from "./format.ts";
import { statusRef, subStatusRef } from "./schemas.ts";
import { aiCtx, registerTool, type ToolDeps } from "./tool.ts";
import { count } from "./tools-read.ts";

const viewRef = () => z.string().trim().min(1).max(100).describe("The saved view: its id (vw_...) or its name (see list_views).");

const filterText = (description: string) => z.string().trim().min(1).max(MAX_FILTER_TEXT).describe(description);

const filters = z
  .strictObject({
    personStatus: statusRef("People views: only people with this person status, by key or label (see list_person_statuses).").optional(),
    subStatus: subStatusRef("People views, with personStatus: only people with this sub-status of it, by key or label.").optional(),
    stage: filterText("Deals views: only deals in this stage, open or closed, by key or label (see list_stages). Without it a deals view shows open deals.").optional(),
    source: filterText("Only people (or, for deals, the deal's person) with this source, ignoring case.").optional(),
    q: filterText("Search text: the name, email, phone or company contains it (for deals, the deal's title too).").optional(),
    fields: z
      .record(z.string().max(100), z.union([z.string().max(2_000), z.number()]))
      .refine((value) => Object.keys(value).length <= MAX_FILTER_FIELDS, `at most ${MAX_FILTER_FIELDS} fields`)
      .optional()
      .describe("Custom fields and the value each holds, by field key or label: contact fields for people, deal fields for deals."),
  })
  .describe(
    "What the view shows. People views take personStatus, subStatus, source, q and fields; deals views take stage, " +
      "source, q and fields. Leave a filter out to show everyone (or every open deal).",
  );

const sorts = (module: "people" | "deals") => Object.keys(VIEW_SORTS[module]).join(", ");
const columns = (module: "people" | "deals") => Object.keys(VIEW_COLUMNS[module]).join(", ");

const viewSettings = {
  sort: z
    .enum(ALL_SORT_KEYS as [string, ...string[]])
    .optional()
    .describe(`People views: ${sorts("people")}. Deals views: ${sorts("deals")}. Default: name for people, days_in_stage for deals.`),
  direction: z.enum(["asc", "desc"]).optional().describe("asc or desc. Default: the sort's own (A to Z, longest in stage, newest first)."),
  layout: z.enum(VIEW_LAYOUTS).optional().describe("cards (the default) or table."),
  columns: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(MAX_COLUMNS)
    .optional()
    .describe(
      `The columns, in order, starting with name (people) or deal (deals). People: ${columns("people")}. Deals: ` +
        `${columns("deals")}. Custom fields by key or label. Default: the usual ones.`,
    ),
};

export function registerViewTools(server: McpServer, deps: ToolDeps): void {
  registerTool(
    server,
    {
      name: "list_views",
      title: "List views",
      kind: "read",
      description:
        "The ways the board shows people and deals, in the order of its view switches: the built-in views (Contacts, " +
        "Leads, Companies; Board, List), then one default view for each person status other than Lead and Contact, then " +
        "the saved views. Each has its board path; saved ones have their id, filters, sort, layout, columns and position.",
      input: z.strictObject({
        module: z.enum(VIEW_MODULES).optional().describe("people or deals; both when left out."),
        includeArchived: z.boolean().optional().describe("true to list archived saved views too."),
      }),
      async run({ module, includeArchived }, { db }) {
        const views = await listViews(db, { module, includeArchived: includeArchived === true });
        const names = views.map((view) => `${view.name}${view.kind === "saved" ? ` (${view.archived ? "archived" : "saved"})` : ""}`);
        return toolResult(`${count(views.length, "view")}: ${names.join(", ")}.`, { views });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "add_view",
      title: "Add a view",
      kind: "write",
      description:
        "Saves a view of people or deals for the board: a name, filters, a sort, a layout and columns. It shows in the " +
        "People switch (people) or the Pipeline switch (deals) after the built-in views. Every person status already " +
        "has a default view (see list_views); add one when the owner wants a narrower or differently sorted list. Only " +
        "when the owner asks.",
      input: z.strictObject({
        name: z.string().trim().min(1).max(100).describe('What the view is called, for example "Partners" (up to 60 characters).'),
        module: z.enum(VIEW_MODULES).describe("people or deals."),
        filters: filters.optional(),
        ...viewSettings,
        position: z.number().int().min(1).max(100).optional().describe("Its place among the module's saved views, counting from 1. Default: last."),
      }),
      async run(args, deps) {
        const result = await addView(aiCtx(deps, "add_view"), args);
        return toolResult(result.summary, { changeId: result.changeId, viewId: result.viewId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "update_view",
      title: "Update a view",
      kind: "write",
      destructive: true,
      idempotent: true,
      description:
        "Changes a saved view: its name, filters (the new filters replace all the old ones; {} for none), sort, " +
        "direction, layout, columns or position. Give only what changes. Only when the owner asks.",
      input: z.strictObject({
        view: viewRef(),
        name: z.string().trim().min(1).max(100).optional().describe("The new name."),
        filters: filters.optional(),
        ...viewSettings,
        position: z.number().int().min(1).max(100).optional().describe("The new place among the module's saved views, counting from 1."),
      }),
      async run({ view, ...patch }, deps) {
        const result = await updateView(aiCtx(deps, "update_view"), view, patch);
        return toolResult(result.summary, { changeId: result.changeId, viewId: result.viewId });
      },
    },
    deps,
  );

  registerTool(
    server,
    {
      name: "archive_view",
      title: "Archive a view",
      kind: "write",
      destructive: true,
      description:
        "Retires a saved view: it leaves the board's view switch and list_views. Nothing it showed changes. Undo it with " +
        "undo_change to bring it back. Default and built-in views can't be archived. Only when the owner asks.",
      input: z.strictObject({ view: viewRef() }),
      async run({ view }, deps) {
        const result = await archiveView(aiCtx(deps, "archive_view"), view);
        return toolResult(result.summary, { changeId: result.changeId, viewId: result.viewId });
      },
    },
    deps,
  );
}
