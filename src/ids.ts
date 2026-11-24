// Text primary keys: <prefix>_<12 lowercase base32 characters> (60 random bits).

export const ID_PREFIXES = ["ct", "dl", "ac", "tk", "ru", "rf", "fd", "br", "chg", "ps", "im", "vw", "pr", "wt", "cr", "te"] as const;

/**
 * ct contact, dl deal, ac activity, tk task, ru rule, rf rule firing, fd field, br brief, chg change, ps push
 * subscription, im board import draft, vw saved view, pr proposal, wt work type, cr client rate, te time entry.
 */
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

/** The same check for a push subscription id ("ps_" ...), used by the board's /notifications/<id>/off. */
export const isPushId = (id: string): boolean => /^ps_[a-z0-9]{1,32}$/.test(id);

/** The same check for a board import draft id ("im_" ...), used by /import/<id> (decision 0036). */
export const isImportId = (id: string): boolean => /^im_[a-z0-9]{1,32}$/.test(id);

/** The same check for a saved view id ("vw_" ...), used by the board's ?view= (decision 0042). */
export const isViewId = (id: string): boolean => /^vw_[a-z0-9]{1,32}$/.test(id);

/** The same check for a proposal id ("pr_" ...), used by apply_changes and propose_changes' replaces (decision 0044). */
export const isProposalId = (id: string): boolean => /^pr_[a-z0-9]{1,32}$/.test(id);

/** The same check for a time entry id ("te_" ...), used by update_time_entry (decision 0049). */
export const isTimeEntryId = (id: string): boolean => /^te_[a-z0-9]{1,32}$/.test(id);

export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte & 31];
  return `${prefix}_${suffix}`;
}
