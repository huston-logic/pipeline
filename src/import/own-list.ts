// "This is my own list" (decision 0038): on the board's check step only, the owner may say they wrote the file, and
// its short, single-line identity values are stored as the owner's (left out of untrusted_fields). Everything else
// from the file stays outside text. Never offered through MCP or the CLI. Pure.

/** The columns the box may confirm: who a person is, never notes, titles, next steps or custom fields. */
export const OWN_LIST_COLUMNS = ["name", "business", "email", "phone", "source"] as const;
export type OwnListColumn = (typeof OWN_LIST_COLUMNS)[number];

/** The longest value the box confirms; a longer one stays outside text, for that value only. */
export const OWN_LIST_MAX = 200;

// Anything that isn't plain visible text on one line: control and format characters (bidi overrides, zero-width
// joiners), surrogates, private use, and line or paragraph separators.
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

/** Whether a cleaned value may be stored as the owner's: at most OWN_LIST_MAX characters of plain text on one line. */
export function isOwnListValue(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim() !== "" && text.length <= OWN_LIST_MAX && !NOT_PLAIN.test(text);
}

/** The columns of `values` the box confirms, in OWN_LIST_COLUMNS order; [] unless `ownList` is on. */
export function confirmedColumns<K extends OwnListColumn>(
  ownList: boolean | undefined,
  values: Partial<Record<K, string | null | undefined>>,
  columns: readonly K[],
): K[] {
  if (ownList !== true) return [];
  return columns.filter((column) => isOwnListValue(values[column]));
}
