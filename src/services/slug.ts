// Keys for stages and custom fields: the label in lowercase ASCII with "_" between words.
import { UserError } from "./errors.ts";

const MAX_KEY = 40;

export function slugOf(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY)
    .replace(/_+$/, "");
  if (slug === "") {
    throw new UserError(`"${label}" has no letters or numbers to build a key from. Use a label with letters or numbers.`);
  }
  return slug;
}

/** `slug`, or slug_2, slug_3, ... when it is taken. */
export function uniqueKey(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
