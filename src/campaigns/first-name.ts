import type { ContactRow } from "../db/db.ts";
import { parseStringArray } from "../services/lookup.ts";

// Letters and marks, with single ' ’ or - between them: a word safe to put after "Hi".
const NAME_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;

/** The word a campaign greets a person with, or null (the email then uses its fallback). */
export function firstNameOf(contact: ContactRow): string | null {
  if (parseStringArray(contact.untrusted_fields).includes("name")) return null;
  const word = contact.name.trim().split(/\s+/)[0] ?? "";
  return word.length >= 1 && word.length <= 40 && NAME_WORD.test(word) ? word : null;
}
