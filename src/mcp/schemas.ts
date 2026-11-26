// Input pieces shared by the tool schemas. Descriptions are what the AI app reads, so they say what each value means
// and which formats are accepted. The pieces the record inputs use live in src/services/input-schemas.ts (services
// never import from src/mcp) and are re-exported here.
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

export { RULE_TYPES, ruleRef, ruleSettings } from "../services/record-inputs.ts";
