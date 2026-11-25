// Who a campaign would go to: the audience worked out against the people on file right now, each person either
// sendable or skipped with a reason. Reads only; approval (freeze.ts) works the list out again and freezes it.
import type { ContactRow, Db, EmailSuppressionRow } from "../db/db.ts";
import { chunkBy, sqlBytes } from "../services/bulk.ts";
import { UserError } from "../services/errors.ts";
import { contactName } from "../services/labels.ts";
import { peopleWhere } from "../services/view-read.ts";
import { parseFilters, type ViewFilters } from "../services/view-spec.ts";
import type { Audience } from "./drafts.ts";
import { firstNameOf } from "./first-name.ts";
import { isPlainAddress } from "./readiness.ts";

export const MAX_AUDIENCE = 2000;

export type SkipReason = "no_email" | "bad_email" | "unsubscribed" | "bounced" | "complained" | "archived";

export interface Member {
  contactId: string;
  /** The safe display name (labels.ts): an outside name shows as "contact ct_...". */
  label: string;
  /** Lowercased and trimmed, or null. */
  email: string | null;
  firstName: string | null;
  leadStatus: string | null;
}

export type Skipped = Member & { reason: SkipReason };

export interface ResolvedAudience {
  sendable: Member[];
  skipped: Skipped[];
  /** Sendable people whose lead status is still New: nobody has been in touch. */
  newLeads: number;
}

const TOO_MANY = `This group has more than ${MAX_AUDIENCE.toLocaleString("en-US")} people. Campaigns go to at most ${MAX_AUDIENCE.toLocaleString("en-US")}; narrow the group.`;

function memberOf(contact: ContactRow): Member {
  const email = contact.email?.trim().toLowerCase() ?? "";
  return {
    contactId: contact.id,
    label: contactName(contact),
    email: email === "" ? null : email,
    firstName: firstNameOf(contact),
    leadStatus: contact.lead_status,
  };
}

const byLabel = (a: Member, b: Member) => {
  const [x, y] = [a.label.toLowerCase(), b.label.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
};

/** The people the audience names, archived ones included only for a list of ids (they are skipped, not dropped). */
async function peopleOf(db: Db, audience: Audience): Promise<{ rows: ContactRow[]; missing: string[] }> {
  if (audience.kind === "people") {
    const found = await db
      .prepare("SELECT * FROM contacts WHERE id IN (SELECT j.value FROM json_each(?) AS j)")
      .bind(JSON.stringify(audience.people))
      .all<ContactRow>();
    const have = new Set(found.results.map((row) => row.id));
    return { rows: found.results, missing: audience.people.filter((id) => !have.has(id)) };
  }
  let filters: ViewFilters;
  if (audience.kind === "status") {
    filters = { person_status: audience.status };
  } else {
    const view = await db.prepare("SELECT filters, archived FROM views WHERE id = ? AND module = 'people'").bind(audience.view).first<{ filters: string; archived: number }>();
    if (view === null || view.archived === 1) throw new UserError("That view is gone or archived. Pick a live view of people.");
    filters = parseFilters(view.filters);
  }
  const where = peopleWhere(filters);
  const found = await db
    .prepare(`SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.id LIMIT ?`)
    .bind(...where.params, MAX_AUDIENCE + 1)
    .all<ContactRow>();
  if (found.results.length > MAX_AUDIENCE) throw new UserError(TOO_MANY);
  return { rows: found.results, missing: [] };
}

async function suppressionsFor(db: Db, emails: string[]): Promise<Map<string, EmailSuppressionRow["reason"]>> {
  const reasons = new Map<string, EmailSuppressionRow["reason"]>();
  const unique = [...new Set(emails)];
  for (const chunk of chunkBy(unique, (email) => sqlBytes(JSON.stringify(email)))) {
    const rows = await db
      .prepare("SELECT email, reason FROM email_suppressions WHERE cleared_at IS NULL AND email IN (SELECT j.value FROM json_each(?) AS j)")
      .bind(JSON.stringify(chunk))
      .all<Pick<EmailSuppressionRow, "email" | "reason">>();
    for (const row of rows.results) reasons.set(row.email, row.reason);
  }
  return reasons;
}

/** Parses a stored campaigns.audience. The draft checks wrote it, so a bad one is a bug, not the owner's mistake. */
export function parseAudience(json: string): Audience {
  const value = JSON.parse(json) as Audience;
  if (value.kind === "status" || value.kind === "view" || value.kind === "people") return value;
  throw new Error("A campaign has an audience this version doesn't know.");
}

/**
 * Who the audience is right now. Skip order: archived, no address, a malformed address, then a live suppression's
 * reason. Over MAX_AUDIENCE people is a UserError. At most three D1 reads for a group of up to 2,000.
 */
export async function resolveAudience(db: Db, _now: Date, audience: Audience): Promise<ResolvedAudience> {
  const { rows, missing } = await peopleOf(db, audience);
  const members = rows.map((row) => ({ member: memberOf(row), archived: row.archived === 1 }));
  const suppressed = await suppressionsFor(
    db,
    members.flatMap(({ member }) => (member.email === null ? [] : [member.email])),
  );
  const sendable: Member[] = [];
  const skipped: Skipped[] = missing.map((id) => ({ contactId: id, label: `contact ${id}`, email: null, firstName: null, leadStatus: null, reason: "archived" }));
  for (const { member, archived } of members) {
    const reason: SkipReason | undefined = archived
      ? "archived"
      : member.email === null
        ? "no_email"
        : !isPlainAddress(member.email)
          ? "bad_email"
          : suppressed.get(member.email);
    if (reason === undefined) sendable.push(member);
    else skipped.push({ ...member, reason });
  }
  sendable.sort(byLabel);
  skipped.sort(byLabel);
  return { sendable, skipped, newLeads: sendable.filter((member) => member.leadStatus === "new").length };
}
