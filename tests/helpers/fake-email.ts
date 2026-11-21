// TEST-ONLY: raw RFC 5322 messages and fake Email Routing messages for the email log tests (decision 0031). Every
// address is a fake one on example.com, example.net or example.org.

export const OWNER = "owner@example.com";
export const LOG_ADDRESS = "log-0123456789abcdef0123456789abcdef@log.example.com";

/** Cloudflare's own verdict for a message that passed, as Email Routing prepends it. */
export const CLOUDFLARE_PASS =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

export interface FakeMail {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  /** null leaves the header out. */
  messageId?: string | null;
  /** Authentication-Results values written into the raw text, top first (none by default): what a sender could forge.
   * fakeMessage puts them in its Headers object after Cloudflare's, as Email Routing does. */
  auth?: string[];
  /** The text/plain part; with `html` too the message is multipart/alternative. */
  text?: string;
  html?: string;
  /** A base64 attachment after the body (multipart/mixed). */
  attachment?: { filename: string; content: string };
}

const CRLF = "\r\n";

function bodyPart(mail: FakeMail): { headers: string[]; body: string } {
  const text = mail.text ?? (mail.html === undefined ? "Hi, following up on our chat." : undefined);
  if (text !== undefined && mail.html !== undefined) {
    const boundary = "alt-boundary-1";
    return {
      headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
      body: [
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        mail.html,
        `--${boundary}--`,
        "",
      ].join(CRLF),
    };
  }
  if (mail.html !== undefined) return { headers: ["Content-Type: text/html; charset=utf-8"], body: mail.html };
  return { headers: ["Content-Type: text/plain; charset=utf-8"], body: text ?? "" };
}

/** A raw message with CRLF line ends, as Email Routing hands it over. */
export function rawEmail(mail: FakeMail = {}): string {
  const headers = (mail.auth ?? []).map((value) => `Authentication-Results: ${value}`);
  headers.push(`From: Owner Example <${mail.from ?? OWNER}>`);
  headers.push(`To: ${mail.to ?? "Pat Example <pat@example.com>"}`);
  if (mail.cc !== undefined) headers.push(`Cc: ${mail.cc}`);
  headers.push(`Subject: ${mail.subject ?? "Following up"}`);
  headers.push(`Date: ${mail.date ?? "Thu, 19 Nov 2026 17:30:00 +0000"}`);
  if (mail.messageId !== null) headers.push(`Message-ID: ${mail.messageId ?? "<fake-1@mail.example.com>"}`);
  headers.push("MIME-Version: 1.0");

  const part = bodyPart(mail);
  if (mail.attachment === undefined) return [...headers, ...part.headers, "", part.body].join(CRLF);
  const boundary = "mixed-boundary-1";
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...part.headers,
    "",
    part.body,
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${mail.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${mail.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.attachment.content).toString("base64"),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

/** A stand-in for Email Routing's ForwardableEmailMessage that records any call to reject, forward or reply. */
export interface FakeMessage {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  calls: string[];
  /** Whether the handler read the raw stream. */
  readonly rawRead: boolean;
  setReject(reason: string): void;
  forward(rcptTo: string): Promise<never>;
  reply(): Promise<never>;
}

/** The Authentication-Results values in a raw message's header block, top first, unfolded. */
function rawAuthResults(raw: string): string[] {
  const end = raw.indexOf(`${CRLF}${CRLF}`);
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r\n(?=[ \t])/g, "");
  return block
    .split(CRLF)
    .filter((line) => /^authentication-results\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
}

export interface FakeEnvelope {
  from?: string;
  to?: string;
  rawSize?: number;
  /** The header Email Routing prepends: its passing verdict by default, null for none (as under `wrangler dev`). */
  cloudflare?: string | null;
  /** Every Authentication-Results value in the Headers object, replacing the production model below. */
  headers?: string[];
}

/**
 * The Headers object as Email Routing builds it: Cloudflare's header, then the message's own Authentication-Results
 * headers from the raw text. Headers joins them into one value with ", ", as in the Workers runtime.
 */
export function fakeMessage(raw: string, envelope: FakeEnvelope = {}): FakeMessage {
  const headers = new Headers();
  const cloudflare = envelope.cloudflare === undefined ? CLOUDFLARE_PASS : envelope.cloudflare;
  const values = envelope.headers ?? [...(cloudflare === null ? [] : [cloudflare]), ...rawAuthResults(raw)];
  for (const value of values) headers.append("Authentication-Results", value);
  const bytes = new TextEncoder().encode(raw);
  const calls: string[] = [];
  let read = false;
  // highWaterMark 0: the stream pulls only when the handler reads it.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    from: envelope.from ?? OWNER,
    to: envelope.to ?? LOG_ADDRESS,
    raw: stream,
    rawSize: envelope.rawSize ?? bytes.byteLength,
    headers,
    calls,
    get rawRead() {
      return read;
    },
    setReject(reason: string) {
      calls.push(`setReject: ${reason}`);
    },
    forward(rcptTo: string) {
      calls.push(`forward: ${rcptTo}`);
      return Promise.reject(new Error("forward is not allowed"));
    },
    reply() {
      calls.push("reply");
      return Promise.reject(new Error("reply is not allowed"));
    },
  };
}
