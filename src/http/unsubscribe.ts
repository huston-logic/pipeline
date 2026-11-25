// /unsubscribe/<token>: the public page behind every campaign email's link and its one-click header (decision 0053,
// hard rules 3 and 4). No sign-in, no CSRF, whatever the sign-in mode and whether campaigns are on or off. It shows
// only the business name. A GET never changes anything (mail scanners open links); the POST does.
import { html, type Html } from "../board/html.ts";
import { DEFAULT_NAME } from "../board/layout.ts";
import { suppress } from "../campaigns/suppressions.ts";
import type { CampaignRecipientRow } from "../db/db.ts";
import type { Env } from "../env.ts";
import { withSecurityHeaders } from "../security.ts";
import { htmlResponse, textResponse } from "./respond.ts";
import { readCappedBytes } from "./limits.ts";

export const UNSUBSCRIBE_PREFIX = "/unsubscribe/";
const STYLESHEET_PATH = "/unsubscribe/board.css";
const TEST_TOKEN = "test";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// A mail client's one-click POST is `List-Unsubscribe=One-Click`; nothing in the body is read.
const BODY_MAX_BYTES = 1024;
const ALLOW = "GET, HEAD, POST";

function page(body: Html, status: number, method: string): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title>
<meta name="description" content="Stop getting emails from this business.">
<link rel="stylesheet" href="/unsubscribe/board.css">
</head>
<body>
<main id="main">
${body}
</main>
</body>
</html>
`;
  const res = htmlResponse(doc.toString(), status);
  return method === "HEAD" ? new Response(null, { status, headers: res.headers }) : res;
}

async function businessName(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT business_name FROM settings LIMIT 1").first<{ business_name: string | null }>();
  return row?.business_name ?? DEFAULT_NAME;
}

const notWorking = (method: string): Response =>
  page(html`<h1>This link doesn't work.</h1><p>Nothing changed.</p>`, 404, method);

async function allowed(request: Request, env: Env): Promise<boolean> {
  if (!env.INTAKE_RATE_LIMIT) return true;
  const key = `unsubscribe:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  return (await env.INTAKE_RATE_LIMIT.limit({ key })).success;
}

async function handle(request: Request, env: Env, now: Date, token: string): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return textResponse("This address only answers GET, HEAD and POST requests.", 405, { Allow: ALLOW });
  }
  if (token !== TEST_TOKEN && !TOKEN_SHAPE.test(token)) return notWorking(method);

  if (method === "POST") {
    if (!(await allowed(request, env))) return textResponse("Too many requests. Wait a minute and try again.", 429, { "Retry-After": "60" });
    await readCappedBytes(request, BODY_MAX_BYTES);
  }

  if (token === TEST_TOKEN) {
    return page(html`<h1>This link is from a test email.</h1><p>Nothing changed.</p>`, 200, method);
  }

  const recipient = await env.DB.prepare("SELECT * FROM campaign_recipients WHERE unsub_token = ?").bind(token).first<CampaignRecipientRow>();
  if (recipient === null) return notWorking(method);
  const business = await businessName(env);

  if (method === "POST") {
    await suppress(env.DB, now, recipient);
    return page(html`<h1>You're unsubscribed.</h1><p>You won't get any more of these emails from ${business}.</p>`, 200, method);
  }
  return page(
    html`<h1>Stop getting emails from ${business}?</h1>
<form method="post" action="${UNSUBSCRIBE_PREFIX}${token}"><button type="submit">Unsubscribe</button></form>`,
    200,
    method,
  );
}

/** Answers every request under /unsubscribe/. A failure is a plain 500 that says nothing about the cause. */
export async function handleUnsubscribe(request: Request, env: Env, now: Date): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === STYLESHEET_PATH) {
    if (method !== "GET" && method !== "HEAD") return textResponse("This address only answers GET and HEAD requests.", 405, { Allow: "GET, HEAD" });
    const asset = await env.ASSETS.fetch(new Request(new URL("/board.css", request.url)));
    return asset.status === 404 ? notWorking(method) : withSecurityHeaders(asset);
  }
  try {
    return await handle(request, env, now, pathname.slice(UNSUBSCRIBE_PREFIX.length));
  } catch {
    console.error(JSON.stringify({ event: "unsubscribe_failed" }));
    return textResponse("Something went wrong on the server. Nothing was changed.", 500);
  }
}
