// Which board page a path is. Matching is separate from drawing so the Worker can ask for a sign-in before it reads
// anything. Every page is read-only. The owner's look (business name) is read once here and handed to the page.
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { type Look, lookOf } from "./layout.ts";
import { briefPage } from "./pages/brief.ts";
import { changesPage } from "./pages/changes.ts";
import { isContactId, isDealId } from "../ids.ts";
import { companiesPage } from "./pages/companies.ts";
import { contactPage } from "./pages/contact.ts";
import { contactsPage } from "./pages/contacts.ts";
import { dealPage } from "./pages/deal.ts";
import { exportPage } from "./pages/export.ts";
import { morePage } from "./pages/more.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { pipelinePage } from "./pages/pipeline.ts";
import { rulesPage } from "./pages/rules.ts";
import { todayPage } from "./pages/today.ts";

export type PageResult = { status: 200 | 404; body: string };
/** `query` is the request's search parameters (only /contacts reads them). */
export type BoardPage = (db: Db, now: Date, query: URLSearchParams) => Promise<PageResult>;
type Page = (db: Db, now: Date, look: Look, query: URLSearchParams) => Promise<string>;

const PAGES = new Map<string, Page>([
  ["/", todayPage],
  ["/pipeline", pipelinePage],
  ["/contacts", contactsPage],
  ["/companies", (db, now, look) => companiesPage(db, now, look)],
  ["/brief", (db, _now, look) => briefPage(db, look)],
  ["/more", async (_db, _now, look) => morePage(look)],
  ["/rules", (db, _now, look) => rulesPage(db, look)],
  ["/changes", changesPage],
  ["/export", async (_db, _now, look) => exportPage(look)],
]);

/** Anything isDealId or isContactId refuses can't be a record, so it gets the plain 404 without a lookup. */
const RECORD_PATHS: { path: RegExp; isId: (id: string) => boolean; page: typeof dealPage }[] = [
  { path: /^\/deals\/([^/]+)$/, isId: isDealId, page: dealPage },
  { path: /^\/contacts\/([^/]+)$/, isId: isContactId, page: contactPage },
];

const lookFor = async (db: Db): Promise<Look> => lookOf(await getSettings(db));

export function matchBoardPage(pathname: string): BoardPage | null {
  const page = PAGES.get(pathname);
  if (page) return async (db, now, query) => ({ status: 200, body: await page(db, now, await lookFor(db), query) });
  for (const record of RECORD_PATHS) {
    const id = record.path.exec(pathname)?.[1];
    if (id === undefined || !record.isId(id)) continue;
    return async (db, now) => {
      const look = await lookFor(db);
      const body = await record.page(db, id, now, look);
      return body === null ? { status: 404, body: notFoundPage(look) } : { status: 200, body };
    };
  }
  return null;
}
