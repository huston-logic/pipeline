import { devAuth } from "./auth/dev.ts";
import { notFoundPage, serverErrorPage } from "./board/pages/not-found.ts";
import { matchBoardPage } from "./board/router.ts";
import { runScheduled } from "./cron.ts";
import type { Env } from "./env.ts";
import { apiMethodNotAllowed, handleApi, isApiPath, json } from "./http/api.ts";
import { handleIntake } from "./http/intake.ts";
import { MCP_ROUTE } from "./mcp/route.ts";
import { withSecurityHeaders } from "./security.ts";

const INTAKE_ROUTE = "/intake";

// A last path segment with an extension (/board.css, /robots.txt) is a static file in out/.
const FILE_PATH = /\/[^/]+\.[A-Za-z0-9]+$/;

const BOARD_NO_SIGN_IN =
  "Sign-in for the board isn't set up on this server yet, so it can't be shown. " +
  "For local development, run `npm run dev` (it turns on the local dev sign-in).";

const SERVER_ERROR = "Something went wrong on the server. Nothing was changed.";

function htmlResponse(body: string, status: number): Response {
  return withSecurityHeaders(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

function textResponse(body: string, status: number): Response {
  return withSecurityHeaders(
    new Response(`${body}\n`, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

function methodNotAllowed(): Response {
  return withSecurityHeaders(
    new Response("The board is read-only. Send a GET request instead.\n", {
      status: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" },
    }),
  );
}

const isRead = (request: Request) => request.method === "GET" || request.method === "HEAD";

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Checked first so a misconfigured sign-in mode refuses every route, not only /mcp.
  const auth = devAuth(request, env);
  if (!auth.ok && auth.status === 500) return textResponse(auth.message, 500);

  const { pathname } = new URL(request.url);
  if (pathname === MCP_ROUTE) {
    if (!auth.ok) return textResponse(auth.message, auth.status);
    // Loaded only for a signed-in /mcp request, so the board (and the Node unit tests) never load the MCP SDK.
    const { handleMcp } = await import("./mcp/handler.ts");
    return withSecurityHeaders(await handleMcp(request, env, ctx, auth.email));
  }

  // /intake has its own secret instead of a sign-in, so it sits outside the /mcp auth gate (decision 0012).
  if (pathname === INTAKE_ROUTE) return withSecurityHeaders(await handleIntake(request, env, new Date()));

  // The board and /api use the /mcp sign-in until production auth exists (plan task 10). Pages that show no data
  // (static files, the 404 page) need none.
  if (isApiPath(pathname)) {
    if (!isRead(request)) return apiMethodNotAllowed();
    if (!auth.ok) return json({ error: BOARD_NO_SIGN_IN }, 401);
    try {
      return await handleApi(request, env, new Date());
    } catch {
      console.error(JSON.stringify({ event: "api_failed" }));
      return json({ error: SERVER_ERROR }, 500);
    }
  }

  if (!isRead(request)) return methodNotAllowed();

  const page = matchBoardPage(pathname);
  if (page) {
    if (!auth.ok) return textResponse(BOARD_NO_SIGN_IN, 401);
    try {
      const result = await page(env.DB, new Date());
      return htmlResponse(result.body, result.status);
    } catch {
      console.error(JSON.stringify({ event: "board_failed" }));
      return htmlResponse(serverErrorPage(), 500);
    }
  }

  if (FILE_PATH.test(pathname)) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withSecurityHeaders(asset);
  }
  return htmlResponse(notFoundPage(), 404);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  // The hourly Cron Trigger. Awaited (not waitUntil): the invocation lasts exactly as long as the run.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env, new Date(controller.scheduledTime));
  },
};
