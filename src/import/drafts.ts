// The board import's drafts (decision 0036, migration 0010): the file an owner uploaded, the column matches they chose
// and, once applied, the counts and the change id. Scratch space like write_guard: not audited, not exported, and
// nothing here writes a log line. The file lives only in import_draft_parts, in pieces of at most CHUNK_BYTES as a SQL
// literal, and is deleted in the same batch that applies the import. A draft expires DRAFT_LIFETIME_MS after it is
// made; deleteExpiredDrafts runs on every import post and in the hourly run (the import's pages never write).
import type { Db, ImportDraftPartRow, ImportDraftRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { CHUNK_BYTES, sqlBytes } from "../services/bulk.ts";
import type { ImportModuleKey, Target } from "./engine.ts";

/** Two hours. */
export const DRAFT_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** What an applied import did, in counts only: what the done step shows. */
export interface ImportResult {
  created: number;
  filled: number;
  unchanged: number;
  skipped: number;
  duplicates: number;
  /** New fields the import added. */
  fields: number;
  /** People a deals import added for their deals (decision 0037). */
  people: number;
  /** Closed deals a deals import brought in as history. */
  closed: number;
}

export interface Draft {
  id: string;
  module: ImportModuleKey;
  expiresAt: string;
  mapping: Target[];
  /** New people come in as leads (New), not contacts. People imports only; false for every other module. */
  asLeads: boolean;
  result: ImportResult | null;
  changeId: string | null;
  version: number;
}

/**
 * `text` in order, cut so each piece measures at most `max` as a SQL literal (sqlBytes), never between the two halves
 * of a surrogate pair.
 */
export function splitText(text: string, max = CHUNK_BYTES): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    let bytes = sqlBytes(text.slice(start, end));
    while (bytes > max) {
      end = start + Math.max(1, Math.min(end - start - 1, Math.floor(((end - start) * max) / bytes)));
      bytes = sqlBytes(text.slice(start, end));
    }
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

const KINDS = new Set(["builtin", "field", "new_field", "notes", "skip"]);

/** A stored mapping, checked: anything that isn't a list of well-formed targets reads as no mapping. */
function parseMapping(json: string): Target[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const targets: Target[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) return [];
    const { kind, key, label } = item as Record<string, unknown>;
    if (typeof kind !== "string" || !KINDS.has(kind)) return [];
    if (kind === "skip") targets.push({ kind });
    else if ((kind === "builtin" || kind === "field") && typeof key === "string") targets.push({ kind, key });
    else if ((kind === "new_field" || kind === "notes") && typeof label === "string") targets.push({ kind, label });
    else return [];
  }
  return targets;
}

function parseResult(json: string | null): ImportResult | null {
  if (json === null) return null;
  const value = JSON.parse(json) as Partial<ImportResult>;
  const n = (x: unknown) => (typeof x === "number" ? x : 0);
  return {
    created: n(value.created),
    filled: n(value.filled),
    unchanged: n(value.unchanged),
    skipped: n(value.skipped),
    duplicates: n(value.duplicates),
    fields: n(value.fields),
    people: n(value.people),
    closed: n(value.closed),
  };
}

function asLeadsOf(json: string): boolean {
  try {
    return (JSON.parse(json) as { asLeads?: unknown }).asLeads === true;
  } catch {
    return false;
  }
}

/** Stores a new draft and its file in one batch; answers its id. */
export async function createDraft(
  db: Db,
  input: { module: ImportModuleKey; text: string; mapping: Target[]; asLeads: boolean; now: Date },
): Promise<string> {
  const id = newId("im");
  const expires = new Date(input.now.getTime() + DRAFT_LIFETIME_MS).toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO import_drafts (id, module, created_at, expires_at, mapping, options) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, input.module, input.now.toISOString(), expires, JSON.stringify(input.mapping), JSON.stringify({ asLeads: input.asLeads })),
    ...splitText(input.text).map((text, i) =>
      db.prepare("INSERT INTO import_draft_parts (draft_id, seq, text) VALUES (?, ?, ?)").bind(id, i + 1, text),
    ),
  ]);
  return id;
}

/** The draft, or null when there is none by that id or it has expired. */
export async function getDraft(db: Db, id: string, now: Date): Promise<Draft | null> {
  const row = await db
    .prepare("SELECT * FROM import_drafts WHERE id = ? AND expires_at > ?")
    .bind(id, now.toISOString())
    .first<ImportDraftRow>();
  if (row === null) return null;
  return {
    id: row.id,
    module: row.module,
    expiresAt: row.expires_at,
    mapping: parseMapping(row.mapping),
    asLeads: asLeadsOf(row.options),
    result: parseResult(row.result),
    changeId: row.change_id,
    version: row.version,
  };
}

/** The draft's file, put back together; "" once it is applied. */
export async function draftText(db: Db, id: string): Promise<string> {
  const rows = await db
    .prepare("SELECT * FROM import_draft_parts WHERE draft_id = ? ORDER BY seq")
    .bind(id)
    .all<ImportDraftPartRow>();
  return rows.results.map((row) => row.text).join("");
}

/** Saves the column matches, only when the draft is still at the version read and not applied. True when saved. */
export async function saveMapping(db: Db, draft: Draft, mapping: Target[], asLeads: boolean): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE import_drafts SET mapping = ?, options = ?, version = version + 1 WHERE id = ? AND version = ? AND result IS NULL",
    )
    .bind(JSON.stringify(mapping), JSON.stringify({ asLeads }), draft.id, draft.version)
    .run();
  return result.meta.changes === 1;
}

/**
 * The guard for the import's own batch (ChangeInput.leading, first in the batch): it fails the whole batch unless the
 * draft is still unapplied, unexpired and at the version read, so a second or racing apply writes nothing.
 */
export function draftGuard(db: Db, draft: Draft, now: Date): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO write_guard (ok) SELECT COUNT(*) = 1 FROM import_drafts " +
        "WHERE id = ? AND version = ? AND result IS NULL AND expires_at > ?",
    )
    .bind(draft.id, draft.version, now.toISOString());
}

/** The statements that mark the draft applied (ChangeInput.extra): the result and change id, then the file's deletion. */
export function appliedStatements(db: Db, draft: Draft, result: ImportResult, changeId: string): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE import_drafts SET result = ?, change_id = ?, version = version + 1 WHERE id = ?")
      .bind(JSON.stringify(result), changeId, draft.id),
    db.prepare("DELETE FROM import_draft_parts WHERE draft_id = ?").bind(draft.id),
  ];
}

/** Marks an import that writes nothing as applied, once, while it hasn't expired. True when this call marked it. */
export async function markApplied(db: Db, draft: Draft, result: ImportResult, now: Date): Promise<boolean> {
  const [marked] = await db.batch([
    db
      .prepare(
        "UPDATE import_drafts SET result = ?, version = version + 1 WHERE id = ? AND version = ? AND result IS NULL AND expires_at > ?",
      )
      .bind(JSON.stringify(result), draft.id, draft.version, now.toISOString()),
    db
      .prepare("DELETE FROM import_draft_parts WHERE draft_id = ? AND EXISTS (SELECT 1 FROM import_drafts WHERE id = ? AND result IS NOT NULL)")
      .bind(draft.id, draft.id),
  ]);
  return marked?.meta.changes === 1;
}

/** Deletes every draft that has expired, with its file. Answers how many drafts went. */
export async function deleteExpiredDrafts(db: Db, now: Date): Promise<number> {
  const stamp = now.toISOString();
  const [, drafts] = await db.batch([
    db.prepare("DELETE FROM import_draft_parts WHERE draft_id IN (SELECT id FROM import_drafts WHERE expires_at <= ?)").bind(stamp),
    db.prepare("DELETE FROM import_drafts WHERE expires_at <= ?").bind(stamp),
  ]);
  return drafts?.meta.changes ?? 0;
}
