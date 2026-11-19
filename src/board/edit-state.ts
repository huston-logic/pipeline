// Which fields of an edit form the owner actually changed (decision 0018). Every edit form carries, beside each
// field, a fingerprint of the value it was drawn with. A field whose posted value still has that fingerprint was left
// alone and is never written, so re-saving a form can't turn outside text into the owner's word (updateContact marks
// every field it sets as the owner's), and can't undo another writer's newer value either.

/** "line" is a one-line input (browsers drop newlines from its value), "text" a textarea (browsers send CRLF). */
export type FieldKind = "line" | "text";

export type FieldOutcome = "unchanged" | "changed" | "conflict";

/**
 * The value as the services would store it from a form: trimmed, with what a browser does to it undone. It covers a
 * textarea's newlines sent as CRLF, newlines dropped from a one-line input's value, and spaces trimmed from the ends
 * (an email input does that). A date input that can't hold its value sends "" instead, and a number can come back
 * spelled differently; record-form.ts handles those (untouchedValue, sameStored).
 */
export function normalize(value: string, kind: FieldKind): string {
  const text = kind === "text" ? value.replace(/\r\n?/g, "\n") : value.replace(/[\r\n]/g, "");
  return text.trim();
}

const encoder = new TextEncoder();

/** 22 url-safe characters of the SHA-256 of the normalized value (128 bits): enough to tell values apart. */
export async function fingerprint(value: string, kind: FieldKind): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(normalize(value, kind))));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").slice(0, 22);
}

/**
 * `posted` is the form's value (null when the field wasn't sent), `was` the fingerprint it was drawn with (null when
 * missing), `current` the stored value now, as the form would show it.
 */
export async function compareField(
  posted: string | null,
  was: string | null,
  current: string,
  kind: FieldKind,
): Promise<FieldOutcome> {
  if (posted === null || normalize(posted, kind) === normalize(current, kind)) return "unchanged";
  if (was === null) return "changed";
  if ((await fingerprint(posted, kind)) === was) return "unchanged";
  return (await fingerprint(current, kind)) === was ? "changed" : "conflict";
}
