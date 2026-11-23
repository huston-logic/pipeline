// Input pieces shared by the tool schemas. Descriptions are what the AI app reads, so they say what each value means
// and which formats are accepted.
import { z } from "zod";

export const WHEN_FORMATS =
  "YYYY-MM-DD (midnight), YYYY-MM-DDTHH:mm in the owner's timezone, or a full ISO time with an offset " +
  "(for example 2026-11-19, 2026-11-19T14:00 or 2026-11-19T22:00:00Z)";

export const when = (what: string) => z.string().max(40).describe(`${what}: ${WHEN_FORMATS}.`);

export const shortText = (description: string) => z.string().max(500).describe(description);

export const longText = (description: string) => z.string().max(10_000).describe(description);

export const fieldValues = (entity: "contact" | "deal") =>
  z
    .record(z.string().max(100), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
    .describe(
      `Custom ${entity} field values by field key (see the owner's custom fields). A null value removes the field.`,
    );

export const dealRef = (description = "The deal: its id (dl_...), its exact title, or its contact's exact name.") =>
  z.string().min(1).max(500).describe(description);

export const contactRef = (description = "The contact: their id (ct_...) or exact name.") =>
  z.string().min(1).max(500).describe(description);

/** A person status (decision 0040), by key or label. */
export const statusRef = (description: string) => z.string().min(1).max(100).describe(description);

/** A sub-status of a person status, by key or label. */
export const subStatusRef = (description: string) => z.string().max(100).describe(description);

export const DEAL_STATUSES = ["open", "won", "lost", "not_now"] as const;

export const FIELD_ENTITIES = ["contact", "deal"] as const;
export const FIELD_TYPES = ["text", "number", "date", "choice"] as const;

/** The schema or null, described on the outside so tools/list shows the description beside the property. */
export const orNull = <T extends z.ZodType>(schema: T) => schema.nullable().describe(schema.description ?? "");

export const RULE_TYPES = ["stage_followup", "on_stage_enter", "gone_quiet", "lead_followup"] as const;

export const ruleRef = () => z.string().min(1).max(100).describe("The rule's id, ru_... (see list_rules).");

/** A rule's settings. Which ones a type takes is checked by the rules service, which names the fix. */
export const ruleSettings = {
  stage: shortText("stage_followup and on_stage_enter: the open stage to watch, its key (proposal_sent) or label (Proposal sent).").optional(),
  status: z
    .enum(["new", "contacted"])
    .optional()
    .describe("lead_followup: the lead status to watch, new or contacted."),
  days: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe(
      "stage_followup: days in the stage with no contact logged (1-365); gone_quiet: days with no contact (1-365); " +
        "lead_followup: days in the status with no contact logged (1-365).",
    ),
  title: shortText(
    "The task title. on_stage_enter needs one; stage_followup's default is \"Follow up with {contact} about {deal}\", " +
      "lead_followup's is \"Follow up with {contact}\". It may use {deal}, {contact} and {stage} ({contact} only for " +
      "lead_followup).",
  ).optional(),
  dueInDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe("on_stage_enter: the task is due this many days after the deal enters the stage (0-365)."),
};
