// Which board page a path is. Matching is separate from drawing so the Worker can ask for a sign-in before it reads
// anything. Every page is read-only. The owner's look (business name) is read once here and handed to the page.
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { type Look, lookOf } from "./layout.ts";
import { briefPage } from "./pages/brief.ts";
import { changesPage } from "./pages/changes.ts";
import { contactsPage } from "./pages/contacts.ts";
import { dealPage } from "./pages/deal.ts";
import { isDealId } from "../ids.ts";
import { exportPage } from "./pages/export.ts";
import { morePage } from "./pages/more.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { pipelinePage } from "./pages/pipeline.ts";
import { rulesPage } from "./pages/rules.ts";
import { todayPage } from "./pages/today.ts";

export type PageResult = { status: 200 | 404; body: string };
export type BoardPage = (db: Db, now: Date) => Promise<PageResult>;
type Page = (db: Db, now: Date, look: Look) => Promise<string>;

const PAGES = new Map<string, Page>([
  ["/", todayPage],
  ["/pipeline", pipelinePage],
  ["/contacts", contactsPage],
  ["/brief", (db, _now, look) => briefPage(db, look)],
  ["/more", async (_db, _now, look) => morePage(look)],
  ["/rules", (db, _now, look) => rulesPage(db, look)],
  ["/changes", changesPage],
  ["/export", async (_db, _now, look) => exportPage(look)],
]);

/** Anything isDealId refuses can't be a deal, so it gets the plain 404 without a lookup. */
const DEAL_PATH = /^\/deals\/([^/]+)$/;

const lookFor = async (db: Db): Promise<Look> => lookOf(await getSettings(db));

export function matchBoardPage(pathname: string): BoardPage | null {
  const page = PAGES.get(pathname);
  if (page) return async (db, now) => ({ status: 200, body: await page(db, now, await lookFor(db)) });
  const id = DEAL_PATH.exec(pathname)?.[1];
  if (id === undefined || !isDealId(id)) return null;
  return async (db, now) => {
    const look = await lookFor(db);
    const body = await dealPage(db, id, now, look);
    return body === null ? { status: 404, body: notFoundPage(look) } : { status: 200, body };
  };
}
