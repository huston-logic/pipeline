// Where a board post sends the browser back to (decision 0017): a path on this board, never another site. The form's
// `return_to` is checked here; anything that is not exactly a board page's path falls back to the record's page.
import { matchBoardPage } from "./router.ts";

const MAX_LENGTH = 2000;
// A base no request ever has, so a value that names its own origin can't pass as this one.
const BASE = "http://board.invalid";

/** The path (and query, without a fragment) when it is a same-origin path to a board page; otherwise null. */
export function boardReturnPath(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > MAX_LENGTH) return null;
  // One leading slash, no second one, no backslash (browsers read it as a slash), no control characters.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  // The path as written must be the path as parsed, so "/./pipeline" or "/a/../pipeline" never sneak through.
  const written = value.split(/[?#]/, 1)[0];
  if (written !== url.pathname || matchBoardPage(url.pathname) === null) return null;
  return url.pathname + url.search;
}

/** The path with `change=<id>` set, replacing any change id already in it. */
export function withChange(path: string, changeId: string): string {
  const url = new URL(path, BASE);
  url.searchParams.delete("change");
  url.searchParams.append("change", changeId);
  return url.pathname + url.search;
}
