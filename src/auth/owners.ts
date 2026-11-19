// Who may sign in: the emails in settings.owner_emails (set at provisioning or by SQL, never through MCP; decision
// 0005) plus the OWNER_EMAILS var. Compared trimmed and lowercased.
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { parseStringArray } from "../services/lookup.ts";

const normalize = (email: string) => email.trim().toLowerCase();

export function parseOwnerEmailsVar(value: string | undefined): string[] {
  return (value ?? "").split(",").map(normalize).filter((email) => email !== "");
}

export async function ownerEmails(db: Db, env: Pick<Env, "OWNER_EMAILS">): Promise<Set<string>> {
  const stored = parseStringArray((await getSettings(db)).owner_emails).map(normalize);
  return new Set([...stored, ...parseOwnerEmailsVar(env.OWNER_EMAILS)].filter((email) => email !== ""));
}

export async function isOwnerEmail(db: Db, env: Pick<Env, "OWNER_EMAILS">, email: string): Promise<boolean> {
  return (await ownerEmails(db, env)).has(normalize(email));
}
