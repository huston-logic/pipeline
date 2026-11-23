// "This is my own list" (decision 0038): on the board's check step only, the owner may say they wrote the file, and
// its short, single-line identity values are stored as the owner's (left out of untrusted_fields). Everything else
// from the file stays outside text. Never offered through MCP or the CLI. Pure.

/** The columns the box may confirm: who a person is, never notes, titles, next steps or custom fields. */
export const OWN_LIST_COLUMNS = ["name", "business", "email", "phone", "source"] as const;
export type OwnListColumn = (typeof OWN_LIST_COLUMNS)[number];

/** The longest value the box confirms; a longer one stays outside text, for that value only. */
export const OWN_LIST_MAX = 200;

// Anything that isn't plain visible text on one line: control and format characters (bidi overrides, zero-width
// joiners), surrogates, private use, line or paragraph separators, characters Unicode says to draw as nothing
// (Default_Ignorable_Code_Point: variation selectors, the combining grapheme joiner, Hangul fillers, tag characters,
// soft hyphens), code points with no character assigned yet, and the braille blank.
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
// More than three combining marks on one character: stacked marks can bury text in a blur.
const STACKED_MARKS = /\p{M}{4}/u;
// Any space but a plain one (U+0020), or two plain ones in a row: which space a value uses could carry hidden text.
const ODD_SPACE = /(?! )[\p{Z}\s]| {2}/u;
// What draws nothing on its own: spaces and combining marks.
const NOT_VISIBLE = /^[\p{Z}\s\p{M}]$/u;

/** Whether at least half of the text's characters (code points) are visible ones, not spaces or combining marks. */
function mostlyVisible(text: string): boolean {
  const chars = [...text];
  const visible = chars.filter((char) => !NOT_VISIBLE.test(char)).length;
  return visible * 2 >= chars.length;
}

/**
 * Whether a cleaned value may be stored as the owner's: at most OWN_LIST_MAX characters of plain text on one line, no
 * invisible characters (NOT_PLAIN), no more than three combining marks in a row, only single plain spaces, and at
 * least half of it visible.
 * Anything else stays outside text.
 */
export function isOwnListValue(text: string | null | undefined): text is string {
  return (
    typeof text === "string" &&
    text.trim() !== "" &&
    text.length <= OWN_LIST_MAX &&
    !NOT_PLAIN.test(text) &&
    !STACKED_MARKS.test(text) &&
    !ODD_SPACE.test(text) &&
    mostlyVisible(text)
  );
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
