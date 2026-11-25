// Input pieces shared by the record inputs (record-inputs.ts) and the MCP tool schemas (src/mcp/schemas.ts re-exports
// them). Descriptions are what the AI app reads, so they say what each value means and which formats are accepted.
import { z } from "zod";

export const WHEN_FORMATS =
  "YYYY-MM-DD (midnight), YYYY-MM-DDTHH:mm in the owner's timezone, or a full ISO time with an offset " +
  "(for example 2026-11-19, 2026-11-19T14:00 or 2026-11-19T22:00:00Z)";

export const when = (what: string) => z.string().max(40).describe(`${what}: ${WHEN_FORMATS}.`);

export const shortText = (description: string) => z.string().max(500).describe(description);

export const longText = (description: string) => z.string().max(10_000).describe(description);

export const fieldValues = (entity: "contact" | "deal" | "project") =>
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
export const statusRef = (description: string) => z.string().trim().min(1).max(100).describe(description);

/** A sub-status of a person status, by key or label; never blank (null clears one where a tool allows it). */
export const subStatusRef = (description: string) => z.string().trim().min(1).max(100).describe(description);

export const DEAL_STATUSES = ["open", "won", "lost", "not_now"] as const;

/** The schema or null, described on the outside so tools/list shows the description beside the property. */
export const orNull = <T extends z.ZodType>(schema: T) => schema.nullable().describe(schema.description ?? "");
