// A board form post (decisions 0014, 0017), checked in this order before any handler reads the form: the sign-in
// (index.ts has already refused a misconfigured dev mode), the same origin, a form body of at most 16 KB (128 KB for
// record forms and Log, decision 0018), then the
// CSRF token. Each refusal writes nothing.
import type { AccessResult } from "../auth/access.ts";
import { getSettings } from "../db/queries.ts";
import type { Env } from "../env.ts";
import { readCappedBody } from "../http/limits.ts";
import { htmlResponse, seeOther, textResponse } from "../http/respond.ts";
import type { MatchedAction } from "./action-kit.ts";
import { CSRF_FIELD, type CsrfMode, csrfFromCookies, csrfMatches } from "./csrf.ts";
import { html } from "./html.ts";
import { type Look, lookOf, renderPage } from "./layout.ts";
import { RETURN_FIELD } from "./forms.ts";
import { boardReturnPath } from "./return-to.ts";

const FORM_TYPE = "application/x-www-form-urlencoded";
export const OUT_OF_DATE = "This page is out of date. Reload it and try again.";

/**
 * The Origin header must be this request's own origin. `Origin: null` (a sandboxed frame, a redirect) is refused.
 * A browser that sends no Origin must say Sec-Fetch-Site: same-origin; a request with neither is refused too.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

const isFormType = (contentType: string | null) => (contentType ?? "").split(";")[0]?.trim().toLowerCase() === FORM_TYPE;

function outOfDatePage(look: Look, back: string): string {
  return renderPage({
    title: "Reload the page",
    description: "The board page this form came from is out of date, so nothing was changed.",
    frame: { look },
    body: html`<h1>Reload the page</h1>
<p class="lede">${OUT_OF_DATE}</p>
<p><a class="button" href="${back}">Open the page again</a></p>`,
  });
}

export async function handleBoardPost(
  request: Request,
  env: Env,
  mode: CsrfMode,
  signIn: () => Promise<AccessResult>,
  action: MatchedAction,
): Promise<Response> {
  const auth = await signIn();
  if (!auth.ok) return textResponse(auth.message, auth.status);
  if (!isSameOrigin(request)) return textResponse("This form didn't come from this board, so nothing was changed.", 403);
  if (!isFormType(request.headers.get("Content-Type"))) {
    return textResponse(`Send the form as ${FORM_TYPE}.`, 415);
  }
  const body = await readCappedBody(request, action.maxBytes);
  if (body === null) return textResponse(`That form is too large. Send at most ${action.maxBytes / 1024} KB.`, 413);
  const form = new URLSearchParams(body);

  const look = lookOf(await getSettings(env.DB));
  const cookie = csrfFromCookies(request, mode);
  if (cookie === null || !(await csrfMatches(cookie, form.get(CSRF_FIELD)))) {
    return htmlResponse(outOfDatePage(look, boardReturnPath(form.get(RETURN_FIELD)) ?? "/"), 403);
  }

  const result = await action.run({ db: env.DB, now: new Date(), csrf: cookie, form, look });
  return result.kind === "redirect" ? seeOther(result.location) : htmlResponse(result.body, result.status);
}
