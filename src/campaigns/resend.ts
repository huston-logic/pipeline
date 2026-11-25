// The only code that calls Resend for campaigns. What each answer means for the "nobody gets the email twice" rule:
// only a status that proves nothing was sent (a refused request) lets a row go back in the queue; a status that might
// have sent something is retried with the same Idempotency-Key and the same payload, or ends as "uncertain" and is
// never sent again. A status is an HTTP status as text or a fixed phrase; no response body, key, address or token is
// ever kept or returned.
const BATCH_URL = "https://api.resend.com/emails/batch";
const ONE_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export type ResendEmail = {
  from: string;
  to: [string];
  reply_to: string;
  subject: string;
  html: string;
  text: string;
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  tags: [{ name: "campaign"; value: string }];
};

export type SendOutcome =
  | { kind: "sent"; ids: string[] }
  | { kind: "retry_later"; status: string }
  | { kind: "returned"; status: string; pause: boolean }
  | { kind: "uncertain"; status: string };

/** Resend fails a whole request it refuses, so nothing was sent. 429 only waits; the others need the owner. */
const RETURNED: Record<number, boolean> = { 429: false, 400: true, 401: true, 403: true, 404: true, 422: true };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function post(
  apiKey: string,
  url: string,
  body: unknown,
  idempotencyKey: string,
  fetchImpl: typeof fetch,
  ids: (json: unknown) => string[] | null,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "pipeline-engine",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (error) {
    return { kind: "retry_later", status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error" };
  }
  const status = String(response.status);
  if (response.status >= 200 && response.status < 300) {
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      return { kind: "uncertain", status };
    }
    const found = response.status === 200 ? ids(json) : null;
    return found === null ? { kind: "uncertain", status } : { kind: "sent", ids: found };
  }
  if (response.status >= 300 && response.status < 400) return { kind: "retry_later", status };
  if (response.status >= 500) return { kind: "retry_later", status };
  if (response.status === 409) {
    let name: unknown = null;
    try {
      const json: unknown = await response.json();
      name = isRecord(json) ? json.name : null;
    } catch {
      name = null;
    }
    return name === "concurrent_idempotent_requests" ? { kind: "retry_later", status } : { kind: "uncertain", status };
  }
  const pause = RETURNED[response.status];
  if (pause !== undefined) return { kind: "returned", status, pause };
  return { kind: "uncertain", status };
}

/** `data` as an array of `{ id: string }`, one per email sent, in order; null for any other shape. */
const batchIds = (count: number) => (json: unknown): string[] | null => {
  if (!isRecord(json) || !Array.isArray(json.data) || json.data.length !== count) return null;
  const ids: string[] = [];
  for (const item of json.data as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string") return null;
    ids.push(item.id);
  }
  return ids;
};

const oneId = (json: unknown): string[] | null => (isRecord(json) && typeof json.id === "string" ? [json.id] : null);

/** One request for up to 100 emails (Resend's limit); results come back in request order. */
export function sendBatch(apiKey: string, emails: ResendEmail[], idempotencyKey: string, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  return post(apiKey, BATCH_URL, emails, idempotencyKey, fetchImpl, batchIds(emails.length));
}

/** One email (the test send): the same outcomes with a single id. */
export function sendOne(apiKey: string, email: ResendEmail, idempotencyKey: string, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  return post(apiKey, ONE_URL, email, idempotencyKey, fetchImpl, oneId);
}
