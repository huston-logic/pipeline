// What a board page gets for one request (decision 0017), instead of a growing list of positional arguments.
import type { CampaignEnv } from "../campaigns/readiness.ts";
import type { Db } from "../db/db.ts";
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
  /** Start timer buttons are offered: time tracking is on and no timer runs (decision 0050). The running timer is in `corner`. */
  startTimer?: boolean;
  /** The Worker's campaign switches, for the review page's readiness check only (decision 0053). Never drawn. */
  campaignEnv?: CampaignEnv;
  /** The board's origin, for the address in a campaign preview's text version. */
  origin?: string;
}

/** The page's path and query without `change`, as a return_to value. */
export function herePath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("change");
  const query = params.toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}
