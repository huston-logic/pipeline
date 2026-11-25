// Input pieces shared by the tool schemas. Descriptions are what the AI app reads, so they say what each value means
// and which formats are accepted. The pieces the record inputs use live in src/services/input-schemas.ts (services
// never import from src/mcp) and are re-exported here.
import { z } from "zod";
import { shortText } from "../services/input-schemas.ts";

export {
  contactRef,
  DEAL_STATUSES,
  dealRef,
  fieldValues,
  longText,
  orNull,
  shortText,
  statusRef,
  subStatusRef,
  when,
  WHEN_FORMATS,
} from "../services/input-schemas.ts";

export const FIELD_ENTITIES = ["contact", "deal", "project"] as const;
export const FIELD_TYPES = ["text", "number", "date", "choice"] as const;

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
