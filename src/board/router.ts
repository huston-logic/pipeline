// Which board page a path is. Matching is separate from drawing so the Worker can ask for a sign-in before it reads
// anything. Every page is read-only.
import type { Db } from "../db/db.ts";
import { briefPage } from "./pages/brief.ts";
import { changesPage } from "./pages/changes.ts";
import { dealPage } from "./pages/deal.ts";
import { isDealId } from "../ids.ts";
import { exportPage } from "./pages/export.ts";
import { homePage } from "./pages/home.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { rulesPage } from "./pages/rules.ts";

export type PageResult = { status: 200 | 404; body: string };
export type BoardPage = (db: Db, now: Date) => Promise<PageResult>;

const ok = (body: string): PageResult => ({ status: 200, body });

const PAGES = new Map<string, BoardPage>([
  ["/", async (db, now) => ok(await homePage(db, now))],
  ["/brief", async (db) => ok(await briefPage(db))],
  ["/rules", async (db) => ok(await rulesPage(db))],
  ["/changes", async (db, now) => ok(await changesPage(db, now))],
  ["/export", async () => ok(exportPage())],
]);

/** Anything isDealId refuses can't be a deal, so it gets the plain 404 without a lookup. */
const DEAL_PATH = /^\/deals\/([^/]+)$/;

export function matchBoardPage(pathname: string): BoardPage | null {
  const page = PAGES.get(pathname);
  if (page) return page;
  const id = DEAL_PATH.exec(pathname)?.[1];
  if (id === undefined || !isDealId(id)) return null;
  return async (db, now) => {
    const body = await dealPage(db, id, now);
    return body === null ? { status: 404, body: notFoundPage() } : ok(body);
  };
}
