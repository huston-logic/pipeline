// Board forms (decision 0014): every one posts to a write route, carries the CSRF token and says where to come back
// to, and works without JavaScript.
import { CSRF_FIELD } from "./csrf.ts";
import { type Html, html } from "./html.ts";

/** Where the form came from and the token: a page's forms need both. */
export type FormContext = { csrf: string; here: string; /** Offer Start timer (decision 0050). */ startTimer?: boolean };

export const RETURN_FIELD = "return_to";

export const hidden = (name: string, value: string): Html => html`<input type="hidden" name="${name}" value="${value}">`;

/** The token and the return path, as hidden fields. */
export const formBasics = (form: FormContext): Html => html`${hidden(CSRF_FIELD, form.csrf)}${hidden(RETURN_FIELD, form.here)}`;

/**
 * A POST form to a board write route. A record form is `novalidate` (decision 0018): the server checks every value
 * and answers with its own errors, and the browser's rules (stricter than intake's for an email) would otherwise
 * block saving a form that holds outside data. The input types stay, for the phone's keyboard. `multipart` is only
 * for the import's upload (decision 0036), the one route that reads multipart/form-data.
 */
export function postForm(
  className: string,
  action: string,
  form: FormContext,
  inner: Html,
  options: { novalidate?: boolean; multipart?: boolean } = {},
): Html {
  const novalidate = options.novalidate ? html` novalidate` : "";
  const enctype = options.multipart ? html` enctype="multipart/form-data"` : "";
  return html`<form class="${className}" method="post" action="${action}"${enctype}${novalidate}>${formBasics(form)}${inner}</form>`;
}
