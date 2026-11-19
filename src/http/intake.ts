// POST /intake: a website contact form's server posts a new enquiry here (decision 0012). Everything in the body is
// outside text, so it is validated, stored in fields marked untrusted, and never read as instructions.
import type { ActivityRow, ContactRow, DealRow } from "../db/db.ts";
import { findContactByEmail } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { commitChange, type Ctx, isDuplicateEmailFailure, oneLine, type RowChange } from "../services/change.ts";
import { dealLabel, isTrusted } from "../services/labels.ts";
import { firstStageOfKind } from "../services/lookup.ts";

export const MAX_BODY_BYTES = 16 * 1024;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_SOURCE = "website form";

class Reject extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(status: number, body: { ok: true } | { ok: false; error: string }, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

const logEvent = (event: string) => console.log(JSON.stringify({ event }));

/** Reads at most MAX_BODY_BYTES, whatever Content-Length claims; a longer body is refused without reading the rest. */
async function readCappedBody(request: Request): Promise<string> {
  const tooBig = () => new Reject(413, "That request is too large. Send at most 16 KB.");
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooBig();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares SHA-256 digests with an XOR loop, so the time doesn't depend on how much of the secret matched. */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

type Fields = Record<string, unknown>;

export function parseBody(contentType: string, text: string): Fields {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    // A null-prototype object, so a field named "__proto__" or "constructor" is just a field.
    const fields: Fields = Object.create(null);
    for (const [key, value] of new URLSearchParams(text)) if (!Object.hasOwn(fields, key)) fields[key] = value;
    return fields;
  }
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Reject(400, "The body isn't valid JSON. Send an object like {\"name\": \"...\", \"email\": \"...\", \"message\": \"...\"}.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Reject(400, "The body must be a JSON object with name, email and message.");
    }
    return parsed as Fields;
  }
  throw new Reject(415, "Send the form as JSON (application/json) or as a form (application/x-www-form-urlencoded).");
}

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9 +().-]+$/;

function text(fields: Fields, key: string): string | null {
  const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Reject(400, `"${key}" must be text.`);
  return value;
}

/** A single-line value: control characters and line breaks become spaces, runs of spaces collapse. */
function line(fields: Fields, key: string, max: number, required: boolean): string | null {
  const raw = text(fields, key);
  const value = raw === null ? "" : oneLine(raw.replace(/[\r\n\t]/g, " ").replace(CONTROL, ""));
  if (value === "") {
    if (required) throw new Reject(400, `"${key}" is required.`);
    return null;
  }
  if (value.length > max) throw new Reject(400, `"${key}" is too long. Use at most ${max} characters.`);
  return value;
}

export interface Enquiry {
  name: string;
  email: string;
  phone: string | null;
  business: string | null;
  source: string;
  message: string;
}

export function validateEnquiry(fields: Fields): Enquiry {
  const name = line(fields, "name", 100, true) as string;
  const email = line(fields, "email", 254, true) as string;
  if (!EMAIL.test(email)) throw new Reject(400, '"email" doesn\'t look like an email address. Use one like name@example.com.');
  const phone = line(fields, "phone", 40, false);
  if (phone !== null && !PHONE.test(phone)) {
    throw new Reject(400, '"phone" may only hold digits, spaces and the characters + ( ) . - Remove anything else.');
  }
  const business = line(fields, "business", 120, false);
  const source = line(fields, "source", 60, false) ?? DEFAULT_SOURCE;
  const rawMessage = text(fields, "message") ?? "";
  const message = rawMessage.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  if (message === "") throw new Reject(400, '"message" is required.');
  if (message.length > 5000) throw new Reject(400, '"message" is too long. Use at most 5,000 characters.');
  return { name, email, phone, business, source, message };
}

async function isRepeat(env: Env, contactId: string, message: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString();
  const found = await env.DB.prepare(
    "SELECT id FROM activities WHERE contact_id = ? AND type = 'form' AND untrusted_text = ? AND created_at >= ? LIMIT 1",
  )
    .bind(contactId, message, since)
    .first<{ id: string }>();
  return found !== null;
}

/** Returns "created", or "repeat" when the same email sent the same message in the last ten minutes. */
async function store(env: Env, enquiry: Enquiry, now: Date): Promise<"created" | "repeat"> {
  const db = env.DB;
  const stage = await firstStageOfKind(db, "open");
  if (!stage) {
    logEvent("intake_no_open_stage");
    throw new Reject(503, "The pipeline isn't ready for new enquiries yet. Try again later.");
  }
  const existing = await findContactByEmail(db, enquiry.email);
  if (existing && (await isRepeat(env, existing.id, enquiry.message, now))) return "repeat";

  const stamp = now.toISOString();
  const changes: RowChange[] = [];
  let contact: ContactRow;
  if (existing) {
    contact = existing;
  } else {
    const written = (["name", "email", "phone", "business", "source"] as const).filter((key) => enquiry[key] !== null);
    contact = {
      id: newId("ct"),
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone,
      business: enquiry.business,
      source: enquiry.source,
      notes: null,
      fields: "{}",
      untrusted_fields: JSON.stringify(written),
      archived: 0,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    changes.push({ table: "contacts", id: contact.id, before: null, after: contact });
  }

  // A trusted existing name is the owner's word; anything built from the submitted name came from outside.
  const nameIsOutside = existing === null || !isTrusted(existing, "name");
  const deal: DealRow = {
    id: newId("dl"),
    contact_id: contact.id,
    title: `${nameIsOutside ? enquiry.name : contact.name} inquiry`,
    stage_key: stage.key,
    value: null,
    next_step: null,
    next_at: null,
    status: "open",
    fields: "{}",
    stage_entered_at: stamp,
    last_activity_at: stamp,
    untrusted_fields: JSON.stringify(nameIsOutside ? ["title"] : []),
    archived: 0,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  };
  changes.push({ table: "deals", id: deal.id, before: null, after: deal });
  const activity: ActivityRow = {
    id: newId("ac"),
    deal_id: deal.id,
    contact_id: contact.id,
    type: "form",
    summary: "Form submission",
    untrusted_text: enquiry.message,
    data: null,
    occurred_at: stamp,
    actor: "system",
    version: 1,
    created_at: stamp,
  };
  changes.push({ table: "activities", id: activity.id, before: null, after: activity });

  const ctx: Ctx = { db, now, actor: "system", tool: "intake" };
  const summary = `Form submission: ${existing ? "new deal for an existing contact" : "new lead"}, ${dealLabel(deal, contact)} in ${stage.label}`;
  await commitChange(ctx, { target: { table: "deals", id: deal.id }, summary, changes });
  return "created";
}

async function handle(request: Request, env: Env, now: Date): Promise<Response> {
  if (request.method !== "POST") throw new Reject(405, "Send the enquiry with POST.", { Allow: "POST" });
  const body = await readCappedBody(request);

  if (env.INTAKE_RATE_LIMIT) {
    const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.INTAKE_RATE_LIMIT.limit({ key });
    if (!success) throw new Reject(429, "Too many requests. Wait a minute and try again.", { "Retry-After": "60" });
  } else {
    logEvent("intake_rate_limit_missing");
  }

  if (!env.INTAKE_SECRET) throw new Reject(503, "Intake isn't set up yet.");
  const given = request.headers.get("X-Intake-Secret");
  if (given === null || !(await secretMatches(given, env.INTAKE_SECRET))) {
    throw new Reject(401, "The intake secret is missing or wrong.");
  }

  const enquiry = validateEnquiry(parseBody(request.headers.get("Content-Type") ?? "", body));
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await store(env, enquiry, now);
      return result === "created" ? json(201, { ok: true }) : json(200, { ok: true });
    } catch (error) {
      // Two enquiries from a new email at once: the second finds the first's contact on the retry.
      if (attempt === 0 && isDuplicateEmailFailure(error)) continue;
      throw error;
    }
  }
}

export async function handleIntake(request: Request, env: Env, now: Date): Promise<Response> {
  try {
    return await handle(request, env, now);
  } catch (error) {
    if (error instanceof Reject) return json(error.status, { ok: false, error: error.message }, error.headers);
    logEvent("intake_failed");
    return json(500, { ok: false, error: "Something went wrong on our side. Try again in a moment." });
  }
}
