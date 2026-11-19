// Board forms (decision 0014): every one posts to a write route, carries the CSRF token and says where to come back
// to, and works without JavaScript.
import { CSRF_FIELD } from "./csrf.ts";
import { type Html, html } from "./html.ts";

/** Where the form came from and the token: a page's forms need both. */
export type FormContext = { csrf: string; here: string };

export const RETURN_FIELD = "return_to";

export const hidden = (name: string, value: string): Html => html`<input type="hidden" name="${name}" value="${value}">`;

/** The token and the return path, as hidden fields. */
export const formBasics = (form: FormContext): Html => html`${hidden(CSRF_FIELD, form.csrf)}${hidden(RETURN_FIELD, form.here)}`;

/** A POST form to a board write route. */
export function postForm(className: string, action: string, form: FormContext, inner: Html): Html {
  return html`<form class="${className}" method="post" action="${action}">${formBasics(form)}${inner}</form>`;
}
