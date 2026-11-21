// Email logging by BCC (decision 0031): the Worker's email() handler. The owner adds the log address in Bcc; Email
// Routing hands the message here. It is logged only when it was sent to the log address, by an owner email, and passed
// Cloudflare's authentication; everything else is dropped silently (never setReject, reply or forward, which would
// tell the sender something). Each matched To or Cc person (at most five) gets one `email` activity, all in one
// audited change, through the same code as log_activity. The subject and body are outside text.
import type { ActivityRow, ContactRow, Db } from "../db/db.ts";
import type { Env } from "../env.ts";
import { ownerEmails } from "../auth/owners.ts";
import { newId } from "../ids.ts";
import { activityEffects } from "../services/activities.ts";
import { commitChange, type Ctx, isEmailLogKeyFailure, type RowChange, StaleWriteError } from "../services/change.ts";
import { contactName } from "../services/labels.ts";
import { LEAD_STATUS_LABELS } from "../services/lead-status.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { localDate } from "../time.ts";
import { logAddressOf } from "./address.ts";
import { authPasses, MAX_RAW_BYTES, messageKey, occurredAt, type ParsedEmail, parseEmail, untrustedText } from "./parse.ts";

export type LogOutcome = "logged" | "duplicate" | "dropped";

/**
 * The part of Email Routing's ForwardableEmailMessage the log reads: the envelope, the Headers object (where Email
 * Routing puts its Authentication-Results) and the raw message. It never gets setReject, reply or forward.
 */
export type LogEmailMessage = Pick<ForwardableEmailMessage, "from" | "to" | "headers" | "raw" | "rawSize">;

export type LogEmailEnv = Pick<Env, "DB" | "EMAIL_LOG_ADDRESS" | "OWNER_EMAILS">;

/** At most this many people are logged per message; the rest are ignored. */
export const MAX_PEOPLE = 5;
/** Only the first this many To and Cc addresses (after the owner's and the log address) are looked up. */
export const MAX_RECIPIENTS = 100;
const LOOKUP_CHUNK = 50;

/** The fixed, trusted summary of a logged email; what it said is in untrusted_text. */
export const LOGGED_SUMMARY = "Logged by BCC";

const normalize = (address: string) => address.trim().toLowerCase();

function drop(reason: string): "dropped" {
  console.log(JSON.stringify({ event: "email_log_dropped", reason }));
  return "dropped";
}

/** The whole stream, or null as soon as it passes `max` bytes. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The people to log (in the order their addresses appear, at most MAX_PEOPLE) and how many addresses matched no one. */
async function findPeople(db: Db, addresses: string[]): Promise<{ people: ContactRow[]; unmatched: number }> {
  const byEmail = new Map<string, ContactRow>();
  for (let i = 0; i < addresses.length; i += LOOKUP_CHUNK) {
    const chunk = addresses.slice(i, i + LOOKUP_CHUNK);
    const found = await db
      .prepare(
        `SELECT * FROM contacts WHERE archived = 0 AND email IS NOT NULL
         AND lower(email) IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...chunk)
      .all<ContactRow>();
    for (const row of found.results) if (row.email !== null) byEmail.set(normalize(row.email), row);
  }
  const matched = addresses.flatMap((address) => byEmail.get(address) ?? []);
  return { people: matched.slice(0, MAX_PEOPLE), unmatched: addresses.length - matched.length };
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type Logged = { key: string; email: ParsedEmail; addresses: string[] };

const INSERT_LOG =
  "INSERT INTO email_log (message_key, received_at, local_date, matched, unmatched) VALUES (?, ?, ?, ?, ?)";

async function record(db: Db, now: Date, { key, email, addresses }: Logged): Promise<"logged" | "duplicate"> {
  const today = localDate(now, await ownerTimezone(db));
  const { people, unmatched } = await findPeople(db, addresses);
  const at = now.toISOString();
  if (people.length === 0) {
    const result = await db.prepare(`${INSERT_LOG} ON CONFLICT (message_key) DO NOTHING`).bind(key, at, today, 0, unmatched).run();
    return result.meta.changes === 0 ? "duplicate" : "logged";
  }

  const occurred = occurredAt(email, now);
  const text = untrustedText(email);
  const changes: RowChange[] = [];
  const activities: ActivityRow[] = [];
  const contacted: ContactRow[] = [];
  for (const person of people) {
    const activity: ActivityRow = {
      id: newId("ac"),
      deal_id: null,
      contact_id: person.id,
      type: "email",
      summary: LOGGED_SUMMARY,
      untrusted_text: text,
      data: null,
      occurred_at: occurred,
      actor: "system",
      version: 1,
      created_at: at,
    };
    activities.push(activity);
    changes.push({ table: "activities", id: activity.id, before: null, after: activity });
    const effects = await activityEffects(db, activity, null, person, now);
    changes.push(...effects.changes);
    if (effects.contacted !== null) contacted.push(person);
  }

  const moved = contacted.length === 0 ? "" : `; ${listOf(contacted.map(contactName))} ${contacted.length === 1 ? "is" : "are"} now ${LEAD_STATUS_LABELS.contacted}`;
  const summary = `Logged an email by BCC with ${listOf(people.map(contactName))}${moved}`;
  const ctx: Ctx = { db, now, actor: "system", tool: "email_log" };
  const target = { table: "activities" as const, id: activities[0]?.id ?? "" };
  // The dedupe row is in the same batch: a delivery that stored this message first fails the whole change.
  const extra = [db.prepare(INSERT_LOG).bind(key, at, today, people.length, unmatched)];
  try {
    await commitChange(ctx, { target, summary, changes, extra });
  } catch (error) {
    if (isEmailLogKeyFailure(error)) return "duplicate";
    throw error;
  }
  return "logged";
}

async function isLogged(db: Db, key: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS found FROM email_log WHERE message_key = ?").bind(key).first()) !== null;
}

export async function handleLogEmail(message: LogEmailMessage, env: LogEmailEnv, now: Date): Promise<LogOutcome> {
  const configured = logAddressOf(env);
  if (configured === null) return drop("not_set_up");
  const logAddress = normalize(configured);
  if (message.rawSize > MAX_RAW_BYTES) return drop("too_large");
  if (normalize(message.to) !== logAddress) return drop("wrong_address");
  const db = env.DB;
  const owners = await ownerEmails(db, env);
  if (!owners.has(normalize(message.from))) return drop("not_owner");
  // From the Headers object, never from the raw text: a header in the raw text may be one the sender wrote.
  if (!authPasses(message.headers.get("authentication-results"))) return drop("not_authenticated");

  const raw = await readCapped(message.raw, MAX_RAW_BYTES);
  if (raw === null) return drop("too_large");
  let email: ParsedEmail;
  try {
    email = await parseEmail(raw);
  } catch {
    return drop("unreadable");
  }
  if (email.from === null || !owners.has(email.from)) return drop("not_owner");

  const key = await messageKey(email);
  const addresses = email.recipients
    .filter((address) => address !== logAddress && !owners.has(address))
    .slice(0, MAX_RECIPIENTS);
  for (let attempt = 0; ; attempt++) {
    if (await isLogged(db, key)) return "duplicate";
    try {
      return await record(db, now, { key, email, addresses });
    } catch (error) {
      // A person or deal that changed between the read and the write is read again once.
      if (attempt === 0 && error instanceof StaleWriteError) continue;
      throw error;
    }
  }
}
