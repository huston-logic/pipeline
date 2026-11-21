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

/**
 * The first Authentication-Results header in a Headers value, split at its top-level semicolons, with comments removed
 * and quoted strings kept whole. Headers joins repeated headers with ", ", and an RFC 8601 token can't hold a comma, so
 * the first comma outside a comment or a quoted string ends the first header; everything after it is ignored.
 */
function firstHeaderParts(value: string): string[] {
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
    } else if (ch === ",") {
      break;
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
  const [first = "", ...rest] = firstHeaderParts(value);
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
 * Ruling 3, on `message.headers.get("authentication-results")`: the Headers object Email Routing builds, where it
 * prepends its own header. Only the first header in the value counts (a header the sender wrote can follow it, joined
 * with ", "); its authserv-id must be exactly mx.cloudflare.net. Pass when it says dmarc=pass, or, when it has no dmarc
 * result, both spf=pass and dkim=pass. A method with two results must pass in both. No header fails.
 */
export function authPasses(value: string | null): boolean {
  if (value === null) return false;
  const { authservId, results } = readAuthResults(value);
  if (authservId !== CLOUDFLARE_AUTHSERV_ID) return false;
  if (results.has("dmarc")) return allPass(results.get("dmarc"));
  return allPass(results.get("spf")) && allPass(results.get("dkim"));
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

/** How much of a body is read before cleaning: enough for MAX_BODY_CHARS after markup and spaces go, and short enough
 * that no regular expression below runs long on a 1 MB body. */
const BODY_INPUT_CHARS = 4 * MAX_BODY_CHARS;

const cleanBody = (text: string) =>
  text
    .slice(0, BODY_INPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The HTML without its script and style blocks, in one pass: an indexOf walk, not a lazy regular expression, so a body
 * full of unclosed `<script` stays linear. A block with no closing tag runs to the end.
 */
function withoutBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  let script = lower.indexOf("<script", at);
  let style = lower.indexOf("<style", at);
  for (;;) {
    if (script !== -1 && script < at) script = lower.indexOf("<script", at);
    if (style !== -1 && style < at) style = lower.indexOf("<style", at);
    const open = script === -1 ? style : style === -1 ? script : Math.min(script, style);
    if (open === -1) return out + html.slice(at);
    out += html.slice(at, open);
    const close = lower.indexOf(open === script ? "</script" : "</style", open);
    const end = close === -1 ? -1 : lower.indexOf(">", close);
    if (end === -1) return out;
    at = end + 1;
  }
}

/**
 * HTML read as text: the body of an HTML-only message (postal-mime 4.2.1 gives no text part for one). Crude, and
 * linear in its input, which is capped first.
 */
export function htmlText(html: string): string {
  return withoutBlocks(html.slice(0, BODY_INPUT_CHARS))
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
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
