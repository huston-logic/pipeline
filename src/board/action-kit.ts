// What every board write handler shares (decisions 0017, 0018): the context it gets once post.ts has run its checks,
// its answers (a 303 or a page), acting as the owner, and where to come back to.
import type { Env } from "../env.ts";
import { type Ctx, StaleWriteError } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import type { PageContext } from "./context.ts";
import { RETURN_FIELD } from "./forms.ts";
import { html, type Html } from "./html.ts";
import { type Look, renderPage } from "./layout.ts";
import { notFoundPage } from "./pages/not-found.ts";
import type { FormState } from "./pages/record-page.ts";
import type { Collected } from "./record-form.ts";
import { boardReturnPath } from "./return-to.ts";

/** What a handler gets once every check has passed. `csrf` is the request's (checked) token, for the forms it draws. */
export interface ActionContext {
  db: Ctx["db"];
  /** The Worker's bindings and secrets, for the one handler that reaches outside the database (Send a test). */
  env: Env;
  now: Date;
  csrf: string;
  form: URLSearchParams;
  /** The parsed multipart body, on the one upload route (decision 0036); its text fields are in `form` too. */
  upload?: FormData;
  look: Look;
  /** The signed-in owner's email (from the sign-in check). */
  email: string;
  /** The request's origin, for links a handler writes into stored data (an approved campaign's base URL). */
  origin: string;
}

export type ActionResult = { kind: "redirect"; location: string } | { kind: "page"; status: 200 | 404 | 422; body: string };

export type BoardAction = (ctx: ActionContext) => Promise<ActionResult>;

/** A matched write route: its handler, how big a form body it reads, and whether that body is multipart. */
export type MatchedAction = { run: BoardAction; maxBytes: number; upload: boolean };

/**
 * One write route. `big` routes (record forms, Log) read up to RECORD_FORM_MAX_BYTES, the rest 16 KB. The `upload`
 * route (the import's file, decision 0036) reads multipart/form-data, and only multipart, up to UPLOAD_MAX_BYTES.
 */
export type Route = { path: RegExp; handle: (ctx: ActionContext, id: string) => Promise<ActionResult>; big?: true; upload?: true };

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

/** A collected form as a refused page draws it, with any extra messages that belong to no one field. */
export const stateOf = (collected: Collected, extra: string[] = []): FormState => ({
  shown: collected.shown,
  errors: [...collected.errors, ...extra.map((message) => ({ message }))],
});

/** A service's refusal, in words for the board: a write that lost a race says so without naming tool calls. */
export function refusal(error: unknown, what: string): string {
  if (error instanceof StaleWriteError) return `This ${what} was changed while you were saving, so nothing was saved. Check the form and save again.`;
  if (error instanceof UserError) return error.message;
  throw error;
}

/** Marks one field of a collected form as wrong. */
export function fieldError(collected: Collected, name: string, message: string): void {
  collected.errors.push({ name, message });
  const item = collected.shown.get(name);
  if (item !== undefined) item.error = message;
}

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
