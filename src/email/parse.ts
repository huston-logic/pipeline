// Reading a logged email (decision 0031). Everything in a message is outside text, apart from the verdict in the
// Authentication-Results header that Cloudflare Email Routing prepends before it hands the message to the Worker.
// postal-mime parses the MIME structure, as Cloudflare's Email Workers docs suggest; only src/email/ imports it.
import PostalMime, { type Address, type Email } from "postal-mime";

export const MAX_RAW_BYTES = 1024 * 1024;
export const MAX_SUBJECT_CHARS = 300;
export const MAX_BODY_CHARS = 5000;
export const MAX_MESSAGE_KEY_CHARS = 300;

/** The authserv-id Email Routing writes in its own Authentication-Results header. */
const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export type HeaderField = { key: string; value: string };

export interface ParsedEmail {
  /** Every header in order, top first, with lower-case keys. */
  headers: HeaderField[];
  /** The header From address, lower-cased, or null when there is none. */
  from: string | null;
  /** The To and then the Cc addresses, groups unwrapped, lower-cased, each once. */
  recipients: string[];
  /** One line, control characters dropped, at most MAX_SUBJECT_CHARS. */
  subject: string;
  /** The text body (or the HTML read as text), newlines normalised, control characters dropped, capped. */
  body: string;
  /** The Date header as a UTC ISO string, or null when it is missing or not a date. */
  date: string | null;
  messageId: string | null;
}

/** The header split at its top-level semicolons, with comments removed and quoted strings kept whole. */
function headerParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (quoted) {
      current += ch;
      if (ch === "\\") current += value.charAt(++i);
      else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    } else if (ch === "(") {
      depth = 1;
      current += " ";
    } else if (ch === ";") {
      parts.push(current.trim());
      current = "";
    } else {
      if (ch === '"') quoted = true;
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

const RESULT = /^([a-z0-9_-]+)(?:\/[0-9]+)?\s*=\s*([a-z0-9_-]+)/i;

/** The authserv-id and each method's results (RFC 8601), for example dmarc → ["pass"]. */
function readAuthResults(value: string): { authservId: string; results: Map<string, string[]> } {
  const [first = "", ...rest] = headerParts(value);
  const results = new Map<string, string[]>();
  for (const part of rest) {
    const match = RESULT.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const method = match[1].toLowerCase();
    results.set(method, [...(results.get(method) ?? []), match[2].toLowerCase()]);
  }
  return { authservId: (first.split(/\s+/)[0] ?? "").toLowerCase(), results };
}

const allPass = (results: string[] | undefined): boolean =>
  results !== undefined && results.length > 0 && results.every((result) => result === "pass");

/**
 * Ruling 3: read only the first Authentication-Results header whose authserv-id is mx.cloudflare.net (Email Routing
 * prepends it; any other may come from the sender). Pass when dmarc=pass, or, when it has no dmarc result, when both
 * spf=pass and dkim=pass. Every result of a method must pass, so a second, forged result can't outvote a fail.
 */
export function authPasses(headers: readonly HeaderField[]): boolean {
  for (const header of headers) {
    if (header.key !== "authentication-results") continue;
    const { authservId, results } = readAuthResults(header.value);
    if (authservId !== CLOUDFLARE_AUTHSERV_ID) continue;
    if (results.has("dmarc")) return allPass(results.get("dmarc"));
    return allPass(results.get("spf")) && allPass(results.get("dkim"));
  }
  return false;
}

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** At most `max` UTF-16 units, without cutting a surrogate pair in half. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const oneLine = (text: string) => text.replace(/[\r\n\t]/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();

const cleanBody = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\n{3,}/g, "\n\n").trim();

/** A crude HTML-to-text, only for a message whose parser gave no text at all. */
function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function mailboxes(addresses: readonly Address[] | undefined): string[] {
  const out: string[] = [];
  for (const address of addresses ?? []) {
    for (const mailbox of address.group ?? [address]) {
      if (mailbox.address !== undefined) out.push(mailbox.address.trim().toLowerCase());
    }
  }
  return out.filter((address) => ADDRESS.test(address));
}

function isoDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function fromAddress(email: Email): string | null {
  return mailboxes(email.from === undefined ? [] : [email.from])[0] ?? null;
}

export async function parseEmail(raw: string | Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw, {
    // Attachments are ignored, and a forwarded message attached whole is one of them.
    forceRfc822Attachments: true,
    maxPartCount: 200,
    maxNestingDepth: 20,
  });
  const text = email.text ?? (email.html === undefined ? "" : htmlText(email.html));
  const messageId = (email.messageId ?? "").trim();
  return {
    headers: email.headers.map(({ key, value }) => ({ key, value })),
    from: fromAddress(email),
    recipients: [...new Set([...mailboxes(email.to), ...mailboxes(email.cc)])],
    subject: cap(oneLine(email.subject ?? ""), MAX_SUBJECT_CHARS),
    body: cap(cleanBody(text), MAX_BODY_CHARS),
    date: isoDate(email.date),
    messageId: messageId === "" ? null : messageId,
  };
}

/** What the activity stores as outside text: the subject line, a blank line, then the body. */
export function untrustedText(email: ParsedEmail): string {
  return `Subject: ${email.subject}\n\n${email.body}`.trimEnd();
}

const firstHeader = (email: ParsedEmail, key: string) => email.headers.find((header) => header.key === key)?.value ?? "";

/** The dedupe key: the Message-ID as given (capped), or without one a sha256 of the raw Date, From and Subject. */
export async function messageKey(email: ParsedEmail): Promise<string> {
  if (email.messageId !== null) return cap(email.messageId, MAX_MESSAGE_KEY_CHARS);
  const source = ["date", "from", "subject"].map((key) => firstHeader(email, key)).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** When the email was sent: its Date header when that is a real time not after now, otherwise now. */
export function occurredAt(email: ParsedEmail, now: Date): string {
  if (email.date === null || Date.parse(email.date) > now.getTime()) return now.toISOString();
  return email.date;
}
