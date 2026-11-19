// /api/*: the board's data as JSON, plus the export downloads. GET and HEAD only, never cached, behind the same sign-in
// as the board (src/index.ts). Answers are the read services' own shapes, so outside text keeps its labels
// (`untrusted_fields`, `untrusted_text`, `untrusted`). Decision 0013.
import { getDeal } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { isDealId } from "../ids.ts";
import { ownerTimezone } from "../services/lookup.ts";
import { changeLog, getDealBrief, latestBrief, pipelineSummary, whatsDue } from "../services/read.ts";
import { listRules } from "../services/rules.ts";
import { withSecurityHeaders } from "../security.ts";
import { localDate } from "../time.ts";
import { csvFilename, exportAll, exportTableCsv, isExportTable, jsonFilename } from "./export.ts";

export const API_PREFIX = "/api/";

const DEAL_PATH = /^\/api\/deals\/([^/]+)$/;
const CSV_PATH = /^\/api\/export\/([^/]+)\.csv$/;

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith(API_PREFIX);

function respond(body: string, status: number, headers: Record<string, string>): Response {
  return withSecurityHeaders(new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } }));
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return respond(`${JSON.stringify(value, null, 2)}\n`, status, { "Content-Type": "application/json; charset=utf-8", ...headers });
}

const attachment = (filename: string) => ({ "Content-Disposition": `attachment; filename="${filename}"` });

export function apiMethodNotAllowed(): Response {
  return json({ error: "The board's API is read-only. Send a GET request instead." }, 405, { Allow: "GET, HEAD" });
}

const notFound = () =>
  json(
    {
      error:
        "There's nothing at this API address. Use /api/pipeline, /api/due, /api/deals/<id>, /api/rules, /api/changes, " +
        "/api/brief, /api/export.json or /api/export/<table>.csv.",
    },
    404,
  );

/** Answers a signed-in GET or HEAD request for a path under /api/. */
export async function handleApi(request: Request, env: Pick<Env, "DB">, now: Date): Promise<Response> {
  const { pathname } = new URL(request.url);
  const db = env.DB;
  switch (pathname) {
    case "/api/pipeline":
      return json(await pipelineSummary(db, now, await ownerTimezone(db)));
    case "/api/due":
      return json(await whatsDue(db, now, await ownerTimezone(db)));
    case "/api/rules":
      return json({ rules: await listRules(db) });
    case "/api/changes":
      return json(await changeLog(db, now));
    case "/api/brief":
      return json({ brief: await latestBrief(db) });
    case "/api/export.json": {
      const tz = await ownerTimezone(db);
      return json(await exportAll(db, now), 200, attachment(jsonFilename(localDate(now, tz))));
    }
  }

  const dealId = DEAL_PATH.exec(pathname)?.[1];
  if (dealId !== undefined) {
    if (!isDealId(dealId) || (await getDeal(db, dealId)) === null) {
      return json({ error: "There's no deal with that id. Use /api/pipeline to find the deal's id (dl_...)." }, 404);
    }
    return json(await getDealBrief(db, dealId, await ownerTimezone(db), now));
  }

  const table = CSV_PATH.exec(pathname)?.[1];
  if (table !== undefined && isExportTable(table)) {
    const tz = await ownerTimezone(db);
    return respond(await exportTableCsv(db, table), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      ...attachment(csvFilename(table, localDate(now, tz))),
    });
  }
  return notFound();
}
