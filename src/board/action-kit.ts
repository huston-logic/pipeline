// What every board write handler shares (decisions 0017, 0018): the context it gets once post.ts has run its checks,
// its answers (a 303 or a page), acting as the owner, and where to come back to.
import type { Ctx } from "../services/change.ts";
import type { PageContext } from "./context.ts";
import { RETURN_FIELD } from "./forms.ts";
import { html, type Html } from "./html.ts";
import { type Look, renderPage } from "./layout.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { boardReturnPath } from "./return-to.ts";

/** What a handler gets once every check has passed. `csrf` is the request's (checked) token, for the forms it draws. */
export interface ActionContext {
  db: Ctx["db"];
  now: Date;
  csrf: string;
  form: URLSearchParams;
  look: Look;
}

export type ActionResult = { kind: "redirect"; location: string } | { kind: "page"; status: 200 | 404 | 422; body: string };

export type BoardAction = (ctx: ActionContext) => Promise<ActionResult>;

export const asOwner = (ctx: ActionContext, tool: string): Ctx => ({ db: ctx.db, now: ctx.now, actor: "owner", tool });

export const redirect = (location: string): ActionResult => ({ kind: "redirect", location });

export const page = (status: 200 | 404 | 422, body: string): ActionResult => ({ kind: "page", status, body });

export const notFound = (ctx: ActionContext): ActionResult => page(404, notFoundPage({ look: ctx.look }));

/** Where to come back to: the form's return_to when it is a board page, else the record's own page. */
export const backTo = (ctx: ActionContext, fallback: string): string => boardReturnPath(ctx.form.get(RETURN_FIELD)) ?? fallback;

/** A page drawn in answer to a post (a refused form): the same frame as a GET of `here`, with no banner. */
export const pageContext = (ctx: ActionContext, here: string): PageContext => ({
  db: ctx.db,
  now: ctx.now,
  query: new URLSearchParams(),
  here,
  csrf: ctx.csrf,
  look: ctx.look,
  banner: "",
});

/**
 * A refused write: the plain-English reason, the form again when there is one, and the way back. `current` is the
 * record's page, so the nav marks its section (a deal is in Pipeline).
 */
export function refusedPage(ctx: ActionContext, title: string, message: string, back: string, form: Html | "", current?: string): string {
  return renderPage({
    title,
    description: "The change was refused, so nothing was changed. The reason is on the page.",
    current,
    frame: { look: ctx.look },
    body: html`<h1>${title}</h1>
<p class="lede refusal">${message}</p>
${form === "" ? "" : html`<div class="card refused-form">${form}</div>`}
<p class="back-link"><a href="${back}">Back to the page</a></p>`,
  });
}

/** A refused inline form (a task, a log entry): its h1, the form with its error summary, and the way back. */
export function refusedFormPage(ctx: ActionContext, title: string, form: Html, back: string, current?: string): string {
  return renderPage({
    title: `Error: ${title}`,
    description: "The form was refused, so nothing was changed. What to fix is on the page.",
    current,
    frame: { look: ctx.look },
    body: html`<h1>${title}</h1>
${form}
<p class="back-link"><a href="${back}">Back to the page</a></p>`,
  });
}
