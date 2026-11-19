// What a board page gets for one request (decision 0017), instead of a growing list of positional arguments.
import type { Db } from "../db/db.ts";
import type { Html } from "./html.ts";
import type { Look, PageFrame } from "./layout.ts";

export interface PageContext extends PageFrame {
  db: Db;
  now: Date;
  /** The request's search parameters. */
  query: URLSearchParams;
  /** This page's path and query without `change`, where its forms come back to (`return_to`). */
  here: string;
  /** The CSRF token for every form's hidden `csrf` field: the same value as this response's cookie. */
  csrf: string;
  look: Look;
  /** The change banner for `?change=<id>`, or "" when there is none. */
  banner: Html | "";
}

/** The page's path and query without `change`, as a return_to value. */
export function herePath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("change");
  const query = params.toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}
