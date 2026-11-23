// Shared request limits for the two places that take a body from a browser or another server: /intake (decision
// 0012) and the board's form posts (decision 0014), including the import's file upload (decision 0036).
import { IMPORT_MAX_BYTES } from "../import/engine.ts";

/** Body size cap for /intake and board posts. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Body size cap for the board's record forms and Log (decision 0018): an edit form posts every field back, and a
 * 10,000-character note of accented text is about 60 KB once form-encoded.
 */
export const RECORD_FORM_MAX_BYTES = 128 * 1024;

/**
 * Body size cap for the board import's upload (decision 0036), the one multipart route: the largest file one import
 * takes, plus 64 KB for the form's other fields and the multipart framing.
 */
export const UPLOAD_MAX_BYTES = IMPORT_MAX_BYTES + 64 * 1024;

/**
 * Reads at most `max` bytes, whatever Content-Length claims, and answers null for a longer body without reading the
 * rest.
 */
export async function readCappedBody(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const bytes = await readCappedBytes(request, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** readCappedBody's bytes, not decoded: a multipart body is parsed from them. */
export async function readCappedBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares SHA-256 digests with an XOR loop, so the time doesn't depend on how much of the secret matched. */
export async function secretMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
