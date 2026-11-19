// Text primary keys: <prefix>_<12 lowercase base32 characters> (60 random bits).

export const ID_PREFIXES = ["ct", "dl", "ac", "tk", "ru", "rf", "fd", "br", "chg"] as const;

/** ct contact, dl deal, ac activity, tk task, ru rule, rf rule firing, fd field, br brief, chg change. */
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Whether text can be a deal id: newId's "dl_" + 12 base32 characters, or the fake dev seed's "dl_seed01" (lowercase
 * letters and digits). The board's /deals/<id> and the API's /api/deals/<id> both use it.
 */
export const isDealId = (id: string): boolean => /^dl_[a-z0-9]{1,32}$/.test(id);

/** The same check for a contact id ("ct_" ...), used by the board's /contacts/<id>. */
export const isContactId = (id: string): boolean => /^ct_[a-z0-9]{1,32}$/.test(id);

/** The same check for a task id ("tk_" ...), used by the board's /tasks/<id>/complete and /snooze. */
export const isTaskId = (id: string): boolean => /^tk_[a-z0-9]{1,32}$/.test(id);

/** The same check for a change id ("chg_" ...), used by the board's ?change= banner and /changes/<id>/undo. */
export const isChangeId = (id: string): boolean => /^chg_[a-z0-9]{1,32}$/.test(id);

export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte & 31];
  return `${prefix}_${suffix}`;
}
