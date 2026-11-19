// Typed reads. Writes go through the audited service layer (src/services/), never through here.
import type {
  ActivityRow,
  AuditRow,
  ContactRow,
  Db,
  DealRow,
  DealStatus,
  FieldDefRow,
  FieldEntity,
  RuleRow,
  RulebookRow,
  SettingsRow,
  StageRow,
  TaskRow,
} from "./db.ts";

/** SQLite treats a negative LIMIT as "no limit". */
const NO_LIMIT = -1;

type Where = { clauses: string[]; params: unknown[] };

function where(): Where {
  return { clauses: [], params: [] };
}

function add(w: Where, clause: string, ...params: unknown[]): void {
  w.clauses.push(clause);
  w.params.push(...params);
}

const whereSql = (w: Where) => (w.clauses.length > 0 ? `WHERE ${w.clauses.join(" AND ")}` : "");

async function all<T>(db: Db, sql: string, params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

export async function getSettings(db: Db): Promise<SettingsRow> {
  const row = await db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>();
  if (!row) throw new Error("The settings row is missing. Load seed/defaults.sql into the database.");
  return row;
}

export async function listStages(db: Db, options: { includeArchived?: boolean } = {}): Promise<StageRow[]> {
  const filter = options.includeArchived ? "" : "WHERE archived = 0";
  return all<StageRow>(db, `SELECT * FROM stages ${filter} ORDER BY position, key`, []);
}

/** Custom field definitions in the order they were added, optionally for one entity. */
export async function listFieldDefs(
  db: Db,
  options: { entity?: FieldEntity; includeArchived?: boolean } = {},
): Promise<FieldDefRow[]> {
  const w = where();
  if (options.entity !== undefined) add(w, "entity = ?", options.entity);
  if (!options.includeArchived) add(w, "archived = 0");
  return all<FieldDefRow>(db, `SELECT * FROM field_defs ${whereSql(w)} ORDER BY entity, created_at, rowid`, w.params);
}

export async function getContact(db: Db, id: string): Promise<ContactRow | null> {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
}

/** Matches like the unique index: ignoring case. Archived contacts count, since the email still belongs to them. */
export async function findContactByEmail(db: Db, email: string): Promise<ContactRow | null> {
  return db
    .prepare("SELECT * FROM contacts WHERE lower(email) = lower(?) AND email IS NOT NULL")
    .bind(email.trim())
    .first<ContactRow>();
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Name, email, business or phone containing `query` (case-insensitive for ASCII), sorted by name. */
export async function searchContacts(
  db: Db,
  query: string,
  options: { limit?: number; includeArchived?: boolean } = {},
): Promise<ContactRow[]> {
  const w = where();
  const text = query.trim();
  if (text) {
    const pattern = `%${escapeLike(text)}%`;
    add(
      w,
      "(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR business LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')",
      pattern,
      pattern,
      pattern,
      pattern,
    );
  }
  if (!options.includeArchived) add(w, "archived = 0");
  return all<ContactRow>(db, `SELECT * FROM contacts ${whereSql(w)} ORDER BY name COLLATE NOCASE, id LIMIT ?`, [
    ...w.params,
    options.limit ?? 20,
  ]);
}

export async function getDeal(db: Db, id: string): Promise<DealRow | null> {
  return db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first<DealRow>();
}

export type DealFilter = {
  stage?: string;
  status?: DealStatus;
  contactId?: string;
  /** next_at earlier than this UTC ISO time. */
  nextAtBefore?: string;
  /** Last contact (or, with none yet, creation) earlier than this UTC ISO time: "gone quiet". */
  lastActivityBefore?: string;
  includeArchived?: boolean;
  limit?: number;
};

/** Board order: stage position, then longest in the stage first. */
export async function listDeals(db: Db, filter: DealFilter = {}): Promise<DealRow[]> {
  const w = where();
  if (filter.stage !== undefined) add(w, "d.stage_key = ?", filter.stage);
  if (filter.status !== undefined) add(w, "d.status = ?", filter.status);
  if (filter.contactId !== undefined) add(w, "d.contact_id = ?", filter.contactId);
  if (filter.nextAtBefore !== undefined) add(w, "d.next_at < ?", filter.nextAtBefore);
  if (filter.lastActivityBefore !== undefined) {
    add(w, "COALESCE(d.last_activity_at, d.created_at) < ?", filter.lastActivityBefore);
  }
  if (!filter.includeArchived) add(w, "d.archived = 0");
  return all<DealRow>(
    db,
    `SELECT d.* FROM deals d JOIN stages s ON s.key = d.stage_key ${whereSql(w)}
     ORDER BY s.position, d.stage_entered_at, d.id LIMIT ?`,
    [...w.params, filter.limit ?? NO_LIMIT],
  );
}

/** A deal's activities, or everything about a contact (their own and their deals'). */
export type ActivityTarget = { dealId: string } | { contactId: string };

/** Newest first. */
export async function listActivities(
  db: Db,
  target: ActivityTarget,
  options: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const [clause, params] =
    "dealId" in target
      ? ["deal_id = ?", [target.dealId]]
      : ["(contact_id = ? OR deal_id IN (SELECT id FROM deals WHERE contact_id = ?))", [target.contactId, target.contactId]];
  return all<ActivityRow>(db, `SELECT * FROM activities WHERE ${clause} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`, [
    ...params,
    options.limit ?? 50,
  ]);
}

export type TaskFilter = {
  dealId?: string;
  /** The contact's own tasks and their deals' tasks. */
  contactId?: string;
  /** true: not done yet; false: done. */
  open?: boolean;
  /** due_at earlier than this UTC ISO time (tasks without a due date are left out). */
  dueBefore?: string;
  /** Leaves out tasks snoozed past this UTC ISO time. */
  awakeAt?: string;
  limit?: number;
};

/** Soonest due first; tasks without a due date last. */
export async function listTasks(db: Db, filter: TaskFilter = {}): Promise<TaskRow[]> {
  const w = where();
  if (filter.dealId !== undefined) add(w, "deal_id = ?", filter.dealId);
  if (filter.contactId !== undefined) {
    add(w, "(contact_id = ? OR deal_id IN (SELECT id FROM deals WHERE contact_id = ?))", filter.contactId, filter.contactId);
  }
  if (filter.open !== undefined) add(w, filter.open ? "done_at IS NULL" : "done_at IS NOT NULL");
  if (filter.dueBefore !== undefined) add(w, "due_at < ?", filter.dueBefore);
  if (filter.awakeAt !== undefined) add(w, "(snoozed_until IS NULL OR snoozed_until <= ?)", filter.awakeAt);
  return all<TaskRow>(
    db,
    `SELECT * FROM tasks ${whereSql(w)} ORDER BY due_at IS NULL, due_at, created_at, id LIMIT ?`,
    [...w.params, filter.limit ?? NO_LIMIT],
  );
}

export async function listRules(db: Db, options: { activeOnly?: boolean } = {}): Promise<RuleRow[]> {
  const filter = options.activeOnly ? "WHERE active = 1" : "";
  return all<RuleRow>(db, `SELECT * FROM rules ${filter} ORDER BY created_at, id`, []);
}

/** Every rulebook document in the order they were added, or just the one named (empty when it doesn't exist). */
export async function getRulebook(db: Db, name?: string): Promise<RulebookRow[]> {
  return name === undefined
    ? all<RulebookRow>(db, "SELECT * FROM rulebook ORDER BY rowid", [])
    : all<RulebookRow>(db, "SELECT * FROM rulebook WHERE name = ?", [name]);
}

/** Changes at or after `since` (UTC ISO), newest first. */
export async function listAudit(db: Db, since: string, options: { limit?: number } = {}): Promise<AuditRow[]> {
  return all<AuditRow>(db, "SELECT * FROM audit_log WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?", [
    since,
    options.limit ?? 100,
  ]);
}
