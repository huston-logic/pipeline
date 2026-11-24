// The database type every module takes, and one row type per table in migrations/. SQLite has no boolean or JSON
// column types: flags are INTEGER 0/1 and JSON is TEXT (parse it where it is used). Times are UTC ISO strings.

import type { LeadStatus } from "./lead-status.ts";

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
  "audit_parts",
  "write_guard",
  "briefs",
  "push_subscriptions",
  "email_log",
  "import_drafts",
  "import_draft_parts",
  "person_statuses",
  "person_substatuses",
  "views",
  "proposals",
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

export type Flag = 0 | 1;
export type Actor = "owner" | "ai" | "system";
export type StageKind = "open" | "won" | "lost" | "not_now";
export type DealStatus = StageKind;
export type FieldEntity = "contact" | "deal";
export type FieldType = "text" | "number" | "date" | "choice";
export type ActivityType = "form" | "email" | "call" | "meeting" | "note" | "stage_change" | "system";
export type RuleType = "stage_followup" | "on_stage_enter" | "gone_quiet" | "lead_followup";

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
  /** Shown in the board's app bar and page titles; null shows "Pipeline" (migration 0004). */
  business_name: string | null;
  /** The board's accent, "#rrggbb" in lower case; null uses the default green (migration 0004). */
  accent_color: string | null;
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

/** One person status (migration 0011, decision 0040). The key is the slug of its first label and never changes. */
export type PersonStatusRow = {
  key: string;
  label: string;
  position: number;
  /** What the sub-status field is called for this status. */
  sub_label: string;
  /** 1: can be renamed and moved but never archived (Lead and Contact). */
  locked: Flag;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

/** One value of a status's sub-status list. Lead's keys are the lead status keys and never change. */
export type PersonSubstatusRow = {
  /** "<status key>.<key>". */
  id: string;
  status_key: string;
  key: string;
  label: string;
  /** 1-based place within its status. */
  position: number;
  archived: Flag;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ViewModule = "people" | "deals";
export type ViewLayout = "cards" | "table";

/** A saved view (migration 0013, decision 0042). */
export type ViewRow = {
  /** "vw_..." */
  id: string;
  name: string;
  module: ViewModule;
  /** JSON object: person_status, sub_status, source, q, fields { <key>: value } and, for deals, stage. */
  filters: string;
  /** "<key>-<asc|desc>". */
  sort: string;
  layout: ViewLayout;
  /** JSON array of column keys; "fields.<key>" for a custom field. */
  columns: string;
  /** 1-based place among the live views of its module. */
  position: number;
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
  /** Null: never a lead. Any status but "qualified" means a lead with no deal (migration 0006, decision 0022). */
  lead_status: LeadStatus | null;
  /** When lead_status last changed; null when it never was set. */
  lead_status_at: string | null;
  /**
   * A person_statuses key (migration 0011, decision 0040): what kind of person they are. "lead" exactly when
   * lead_status is an unqualified status, and then sub_status equals lead_status (personStatusPatch keeps them so).
   */
  person_status: string;
  /** A person_substatuses key of that status, or null for none. */
  sub_status: string | null;
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
  /** JSON array of the columns whose values came from outside (intake, import), for example ["title"]. */
  untrusted_fields: string;
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
  /** JSON array of the columns whose values came from outside, for example ["title"] for a title built from one. */
  untrusted_fields: string;
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
  /** Set for deal rules; null for a lead_followup firing. */
  deal_id: string | null;
  /** Set for every firing made after migration 0006; the deal's contact for older ones. */
  contact_id: string | null;
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

export type BriefRow = {
  id: string;
  /** The owner's local date, YYYY-MM-DD; one brief per date. */
  local_date: string;
  composed_at: string;
  text: string;
  /** JSON array of the brief's items (see src/brief/compose.ts). */
  items: string;
  sent_at: string | null;
  /** Why the email did or did not go: "sent", "off: <reason>" or "failed: <HTTP status>". */
  send_status: string | null;
};

/** One accepted logged email (decision 0031): a system log, not audited. */
export type EmailLogRow = {
  /** The Message-ID as given, or "sha256:" and the hex of its Date, From and Subject. */
  message_key: string;
  received_at: string;
  /** The owner's local date when it arrived, YYYY-MM-DD. */
  local_date: string;
  /** How many people it was logged for (at most 5). */
  matched: number;
  /** How many of its other To and Cc addresses matched no one. */
  unmatched: number;
};

/** One browser that turned notifications on (decision 0030). Its values come from the owner's own browser. */
export type PushSubscriptionRow = {
  id: string;
  /** The push service's https URL for this browser. Never shown in a summary or a log. */
  endpoint: string;
  /** The browser's P-256 public key (65 bytes) and auth secret (16 bytes), base64url. */
  p256dh: string;
  auth: string;
  created_at: string;
  /** When it was turned off, or the push service said it is gone; null while notifications are on. */
  gone_at: string | null;
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
  /**
   * How many audit_parts rows hold the snapshot (migration 0009, decision 0035). 0: the snapshot is in before_json
   * and after_json; otherwise those are "{}" and the snapshot is the union of the parts.
   */
  parts: number;
};

/** The board import's draft (migration 0010, decision 0036): scratch space, never audited, exported or logged. */
export type ImportDraftRow = {
  id: string;
  module: "people" | "deals" | "tasks";
  created_at: string;
  expires_at: string;
  /** The column matches, as a JSON array of import targets. */
  mapping: string;
  /** JSON object: how new people come in (asLeads). */
  options: string;
  /** JSON counts once applied; null before. */
  result: string | null;
  /** The import's change, once applied and when it wrote anything. */
  change_id: string | null;
  version: number;
};

/** One piece of a draft's file, at most CHUNK_BYTES as a SQL literal, in seq order. */
export type ImportDraftPartRow = { draft_id: string; seq: number; text: string };

export type ProposalStatus = "open" | "applied" | "dropped";

/** A list of record changes waiting for the owner's yes (migration 0014, decision 0044): scratch space, never audited. */
export type ProposalRow = {
  id: string;
  /** JSON array: the resolved actions (ids; "@n" names a record an earlier action adds). */
  actions: string;
  /** JSON object {"<table>:<id>": version | null}: every row the plan writes, with the version read (null: added). */
  reads: string;
  /** The list exactly as the owner was shown it. */
  text: string;
  status: ProposalStatus;
  replaced_by: string | null;
  change_id: string | null;
  created_at: string;
  expires_at: string;
};

/** One piece of a big change's snapshot (migration 0009): the same shape as before_json/after_json, for some rows. */
export type AuditPartRow = {
  change_id: string;
  /** 1, 2, ...: the order the rows were written in. */
  seq: number;
  before_json: string;
  after_json: string;
};
