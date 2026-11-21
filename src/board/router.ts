// Which board page a path is. Matching is separate from drawing so the Worker can ask for a sign-in before it reads
// anything. The owner's look (business name) and the change banner are read once here and handed to the page in its
// PageContext (decision 0017).
import type { Db } from "../db/db.ts";
import { getSettings } from "../db/queries.ts";
import { changeBanner } from "./banner.ts";
import { herePath, type PageContext } from "./context.ts";
import { lookOf } from "./layout.ts";
import { briefPage } from "./pages/brief.ts";
import { changesPage } from "./pages/changes.ts";
import { isContactId, isDealId } from "../ids.ts";
import { companiesPage } from "./pages/companies.ts";
import { contactPage } from "./pages/contact.ts";
import { contactEditPage } from "./pages/contact-edit.ts";
import { contactsPage } from "./pages/contacts.ts";
import { dealEditPage } from "./pages/deal-edit.ts";
import { newDealPage } from "./pages/deal-new.ts";
import { dealPage } from "./pages/deal.ts";
import { exportPage } from "./pages/export.ts";
import { LEAD_PATH, leadPage } from "./pages/lead-new.ts";
import { leadsPage } from "./pages/leads.ts";
import { morePage } from "./pages/more.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { pipelinePage } from "./pages/pipeline.ts";
import { rulesPage } from "./pages/rules.ts";
import { todayPage } from "./pages/today.ts";

export type PageResult = { status: 200 | 404; body: string };
/** One GET of a board page: the database, the clock, the URL and this response's CSRF token. */
export type PageRequest = { db: Db; now: Date; url: URL; csrf: string };
export type BoardPage = (request: PageRequest) => Promise<PageResult>;
type Page = (ctx: PageContext) => Promise<string>;
type RecordPage = (ctx: PageContext, id: string) => Promise<string | null>;

const PAGES = new Map<string, Page>([
  ["/", todayPage],
  ["/pipeline", pipelinePage],
  ["/contacts", contactsPage],
  ["/companies", companiesPage],
  ["/leads", leadsPage],
  ["/brief", briefPage],
  ["/more", morePage],
  ["/rules", rulesPage],
  ["/changes", changesPage],
  ["/export", exportPage],
  [LEAD_PATH, (ctx) => leadPage(ctx)],
]);

/** Anything isDealId or isContactId refuses can't be a record, so it gets the plain 404 without a lookup. */
const RECORD_PATHS: { path: RegExp; isId: (id: string) => boolean; page: RecordPage }[] = [
  { path: /^\/deals\/([^/]+)$/, isId: isDealId, page: dealPage },
  { path: /^\/contacts\/([^/]+)$/, isId: isContactId, page: contactPage },
  { path: /^\/deals\/([^/]+)\/edit$/, isId: isDealId, page: (ctx, id) => dealEditPage(ctx, id) },
  { path: /^\/contacts\/([^/]+)\/edit$/, isId: isContactId, page: (ctx, id) => contactEditPage(ctx, id) },
  { path: /^\/contacts\/([^/]+)\/deals\/new$/, isId: isContactId, page: (ctx, id) => newDealPage(ctx, id) },
];

async function contextFor({ db, now, url, csrf }: PageRequest): Promise<PageContext> {
  const here = herePath(url);
  return {
    db,
    now,
    query: url.searchParams,
    here,
    csrf,
    look: lookOf(await getSettings(db)),
    banner: await changeBanner(db, url.searchParams, { csrf, here }),
  };
}

export function matchBoardPage(pathname: string): BoardPage | null {
  const page = PAGES.get(pathname);
  if (page) return async (request) => ({ status: 200, body: await page(await contextFor(request)) });
  for (const record of RECORD_PATHS) {
    const id = record.path.exec(pathname)?.[1];
    if (id === undefined || !record.isId(id)) continue;
    return async (request) => {
      const ctx = await contextFor(request);
      const body = await record.page(ctx, id);
      return body === null ? { status: 404, body: notFoundPage({ look: ctx.look }) } : { status: 200, body };
    };
  }
  return null;
}
