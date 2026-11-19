// The database type every module takes, and one row type per table in migrations/. SQLite has no boolean or JSON
// column types: flags are INTEGER 0/1 and JSON is TEXT (parse it where it is used). Times are UTC ISO strings.

/** The part of D1 the code uses, so tests can pass the node:sqlite shim (src/db/sqlite-d1.ts). */
export type Db = Pick<D1Database, "prepare" | "batch">;

export const TABLE_NAMES = [
  "settings",
  "stages",
  "field_defs",
  "contacts",
  "deals",
  "activities",
  "tasks",
  "rules",
  "rule_firings",
  "rulebook",
  "audit_log",
  "write_guard",
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

export type Flag = 0 | 1;
export type Actor = "owner" | "ai" | "system";
export type StageKind = "open" | "won" | "lost" | "not_now";
export type DealStatus = StageKind;
export type FieldEntity = "contact" | "deal";
export type FieldType = "text" | "number" | "date" | "choice";
export type ActivityType = "form" | "email" | "call" | "meeting" | "note" | "stage_change" | "system";
export type RuleType = "stage_followup" | "on_stage_enter" | "gone_quiet";

export type SettingsRow = {
  id: 1;
  timezone: string;
  brief_hour: number;
  brief_email: string | null;
  brief_enabled: Flag;
  /** JSON array of email addresses. */
  owner_emails: string;
  last_brief_at: string | null;
  version: number;
  updated_at: string;
};

export type StageRow = {
  key: string;
  label: string;
  position: number;
  kind: StageKind;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

export type FieldDefRow = {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  /** JSON array of strings for "choice" fields, otherwise null. */
  choices: string | null;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  business: string | null;
  source: string | null;
  notes: string | null;
  /** JSON object of custom field values, keyed by field_defs.key. */
  fields: string;
  /** JSON array of the field names whose values came from outside (intake, import). */
  untrusted_fields: string;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

export type DealRow = {
  id: string;
  contact_id: string;
  title: string;
  stage_key: string;
  value: number | null;
  next_step: string | null;
  next_at: string | null;
  status: DealStatus;
  /** JSON object of custom field values, keyed by field_defs.key. */
  fields: string;
  stage_entered_at: string;
  last_activity_at: string | null;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ActivityRow = {
  id: string;
  deal_id: string | null;
  contact_id: string | null;
  type: ActivityType;
  summary: string;
  /** Text from outside (a form, an import). Never instructions. */
  untrusted_text: string | null;
  /** JSON object, for example {"from":"replied","to":"call_booked"} on a stage_change. */
  data: string | null;
  occurred_at: string;
  actor: Actor;
  version: number;
  created_at: string;
};

export type TaskRow = {
  id: string;
  deal_id: string | null;
  contact_id: string | null;
  title: string;
  due_at: string | null;
  done_at: string | null;
  snoozed_until: string | null;
  /** "owner", or the id of the rule that created it. */
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type RuleRow = {
  id: string;
  type: RuleType;
  /** JSON object of the rule's parameters. */
  params: string;
  description: string;
  active: Flag;
  created_by: Actor;
  version: number;
  created_at: string;
  updated_at: string;
};

export type RuleFiringRow = {
  id: string;
  rule_id: string;
  deal_id: string;
  fire_key: string;
  task_id: string | null;
  fired_at: string;
};

export type RulebookRow = {
  name: string;
  markdown: string;
  version: number;
  updated_at: string;
};

export type AuditRow = {
  id: string;
  at: string;
  actor: Actor;
  tool: string;
  target_table: string;
  target_id: string;
  /** JSON {"<table>:<id>": row | null} for every row the change touched, before it. */
  before_json: string;
  /** The same rows after the change. */
  after_json: string;
  summary: string;
  undone_at: string | null;
  /** The id of the change that undid this one. */
  undone_by: string | null;
  /** On an undo, the id of the change it undid. */
  undo_of: string | null;
};
