// TEST-ONLY: give a fake person a lead status the way production does (decision 0040): an unqualified status makes them
// a Lead with it as the sub-status; Qualified or none makes them a Contact. Test databases refuse a row whose two
// pairs disagree (src/db/sqlite-d1.ts), so a test that sets a lead status by SQL goes through here.
import type { Db } from "../../src/db/db.ts";
import { isUnqualified, type LeadStatus } from "../../src/services/lead-status.ts";

/** The person_status and sub_status that go with a lead status. */
export function personFor(status: LeadStatus | null): { person_status: string; sub_status: string | null } {
  return status !== null && isUnqualified(status) ? { person_status: "lead", sub_status: status } : { person_status: "contact", sub_status: null };
}

/** The two values as SQL literals, for an INSERT's `person_status, sub_status` columns: "'lead', 'new'". */
export function personSql(status: LeadStatus | null): string {
  const { person_status, sub_status } = personFor(status);
  return `'${person_status}', ${sub_status === null ? "NULL" : `'${sub_status}'`}`;
}

/**
 * Sets a person's lead status and the person status that goes with it, without a change record (test setup only).
 * `at` sets lead_status_at too; leave it out to keep the stored one.
 */
export async function setLeadStatus(db: Db, contactId: string, status: LeadStatus | null, at?: string | null): Promise<void> {
  const { person_status, sub_status } = personFor(status);
  const sql =
    at === undefined
      ? "UPDATE contacts SET lead_status = ?, person_status = ?, sub_status = ? WHERE id = ?"
      : "UPDATE contacts SET lead_status = ?, person_status = ?, sub_status = ?, lead_status_at = ? WHERE id = ?";
  const binds = at === undefined ? [status, person_status, sub_status, contactId] : [status, person_status, sub_status, at, contactId];
  await db.prepare(sql).bind(...binds).run();
}
