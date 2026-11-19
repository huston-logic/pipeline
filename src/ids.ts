// Text primary keys: <prefix>_<12 lowercase base32 characters> (60 random bits).

export const ID_PREFIXES = ["ct", "dl", "ac", "tk", "ru", "rf", "fd", "br", "chg"] as const;

/** ct contact, dl deal, ac activity, tk task, ru rule, rf rule firing, fd field, br brief, chg change. */
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte & 31];
  return `${prefix}_${suffix}`;
}
