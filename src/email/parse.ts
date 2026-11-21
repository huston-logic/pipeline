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
 * One Authentication-Results header split at its top-level semicolons, with comments removed and quoted strings kept
 * whole; null when it holds a comma outside a comment or quoted string (an RFC 8601 header never does, so it would be
 * more than one header), a ";" inside one (a comment can hide a result only by covering the ";" that starts it, so
 * sender values that open and close one around Cloudflare's own result are refused), or ends inside one (a sender's
 * value it copied broke it).
 */
function headerParts(value: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    // An escaped ";" counts too, or a backslash just before Cloudflare's own ";" would carry a comment over it.
    if ((quoted || depth > 0) && (ch === ";" || (ch === "\\" && value.charAt(i + 1) === ";"))) {
      return null;
    } else if (quoted) {
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
      return null;
    } else {
      if (ch === '"') quoted = true;
      current += ch;
    }
  }
  if (quoted || depth > 0) return null;
  parts.push(current.trim());
  return parts;
}

const RESULT = /^([a-z0-9_-]+)(?:\/[0-9]+)?\s*=\s*([a-z0-9_-]+)/i;

/** The authserv-id and each method's results (RFC 8601), for example dmarc → ["pass"]; null for a broken header. */
function readAuthResults(value: string): { authservId: string; results: Map<string, string[]> } | null {
  const parts = headerParts(value);
  if (parts === null) return null;
  const [first = "", ...rest] = parts;
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

/** Folding whitespace evened out, so a header unfolded one way by Cloudflare and another by postal-mime still match. */
const evenSpaces = (value: string) => value.replace(/[ \t\r\n]+/g, " ").trim();

/**
 * Cloudflare's own header, by subtraction: the Headers value is Cloudflare's header, then ", " and the message's own
 * Authentication-Results headers joined with ", " (when it has any). Null unless the value ends exactly that way and
 * something is left in front.
 */
function cloudflareHeader(value: string, own: readonly string[]): string | null {
  const whole = evenSpaces(value);
  if (own.length === 0) return whole === "" ? null : whole;
  const suffix = `, ${own.map(evenSpaces).join(", ")}`;
  if (!whole.endsWith(suffix)) return null;
  const header = whole.slice(0, whole.length - suffix.length).trim();
  return header === "" ? null : header;
}

/**
 * Ruling 3, on `message.headers.get("authentication-results")` (the Headers object Email Routing builds and prepends
 * its own header to) and `own`, the message's own Authentication-Results values from the raw text (ownAuthResults).
 * Only Cloudflare's header is read, found by taking the message's own headers off the end (cloudflareHeader), never by
 * parsing where one header stops: a sender's value Cloudflare copies in could hide that. Its authserv-id must be
 * exactly mx.cloudflare.net. Pass when it says dmarc=pass (every dmarc result in it), or, when it has no dmarc result,
 * spf=pass and dkim=pass (every result of each). No header, no match, or a broken header fails.
 */
export function authPasses(value: string | null, own: readonly string[]): boolean {
  if (value === null) return false;
  const header = cloudflareHeader(value, own);
  if (header === null) return false;
  const read = readAuthResults(header);
  if (read === null || read.authservId !== CLOUDFLARE_AUTHSERV_ID) return false;
  if (read.results.has("dmarc")) return allPass(read.results.get("dmarc"));
  return allPass(read.results.get("spf")) && allPass(read.results.get("dkim"));
}

/**
 * The message's own Authentication-Results values, top first. A name with spaces before its colon counts too: one
 * counted here that Email Routing did not put in the Headers object makes the subtraction fail, the safe way round.
 */
export function ownAuthResults(email: ParsedEmail): string[] {
  return email.headers.filter((header) => header.key.trim() === "authentication-results").map((header) => header.value);
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
  // Matched on the text as given (no lower-cased copy, whose positions drift where a letter such as "İ" grows), and
  // without the u flag, so only ASCII letters match the tag names, as in a browser.
  const open = /<(script|style)/gi;
  const close = { script: /<\/script/gi, style: /<\/style/gi };
  let out = "";
  let at = 0;
  for (;;) {
    open.lastIndex = at;
    const start = open.exec(html);
    if (start === null) return out + html.slice(at);
    out += html.slice(at, start.index);
    const closing = start[1]?.toLowerCase() === "style" ? close.style : close.script;
    closing.lastIndex = start.index;
    const shut = closing.exec(html);
    const end = shut === null ? -1 : html.indexOf(">", shut.index);
    if (end === -1) return out;
    at = end + 1;
  }
}

/** A tag, as the text between its < and >, that ends a line: <br>, <br/>, </p>, </div>, </li>, </tr>, </h1> to </h6>. */
const LINE_BREAK = /^(?:br\s*\/?|\/(?:p|div|li|tr|h[1-6]))$/i;
const LONGEST_LINE_BREAK = 8;

/**
 * The HTML with its tags gone, in one indexOf walk: every "<" starts a tag that runs to the next ">", or to the end when
 * there is none. Only text between tags is kept, so no "<" from the markup is left, and no tag can be pieced together
 * from the parts of others (a regular expression that removes one tag at a time turns "<scr<b>ipt>" into "<script>").
 */
function withoutTags(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    if (open === -1) return out + html.slice(at);
    out += html.slice(at, open);
    const close = html.indexOf(">", open + 1);
    if (close === -1) return out;
    if (close - open - 1 <= LONGEST_LINE_BREAK && LINE_BREAK.test(html.slice(open + 1, close))) out += "\n";
    at = close + 1;
  }
}

const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" };

/**
 * HTML read as text: the body of an HTML-only message (postal-mime 4.2.1 gives no text part for one). Crude, and
 * linear in its input, which is capped first. Entities are decoded once, after the tags are gone, so "&lt;b&gt;" is the
 * visible text "<b>" a reader saw, and "&amp;lt;" stays "&lt;". The result is plain outside text, escaped wherever it
 * is shown.
 */
export function htmlText(html: string): string {
  return withoutTags(withoutBlocks(html.slice(0, BODY_INPUT_CHARS))).replace(
    /&(nbsp|lt|gt|quot|#39|amp);/g,
    (entity, name: string) => ENTITIES[name] ?? entity,
  );
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
