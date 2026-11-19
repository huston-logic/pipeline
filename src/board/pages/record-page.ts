// The frame every record form page shares (decision 0018): a way back, the h1, one line on what the form does, the
// error summary when a post was refused, the fields in cards, and the submit button beside Cancel.
import type { PageContext } from "../context.ts";
import { postForm } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { section } from "../parts.ts";
import type { FormError, Shown, Spec } from "../record-form.ts";
import { anyOutside, formErrorSummary, specFields } from "../record-fields.ts";
import { outsideNote } from "../records.ts";

/** What a refused post draws the form with: each field as posted (or as stored), and the errors. */
export type FormState = { shown: Map<string, Shown>; errors: FormError[] };

export type RecordPageOptions = {
  title: string;
  description: string;
  heading: Html | string;
  lede: string;
  /** The nav item this page is part of. */
  current?: string;
  back: { href: string; text: string };
  action: string;
  /** Where Cancel goes, and the form's return_to. */
  cancel: string;
  submit: string;
  prefix: string;
  /** One card per group; a group with a heading is its own section. */
  groups: { heading?: string; id?: string; specs: Spec[] }[];
  shown: Map<string, Shown>;
  errors: FormError[];
};

export function recordFormPage(ctx: PageContext, options: RecordPageOptions): string {
  const specs = options.groups.flatMap((group) => group.specs);
  const cards = options.groups.map((group) => {
    const card = html`<div class="card form-card">
${specFields(group.specs, options.shown, options.prefix)}
</div>`;
    return group.heading === undefined || group.id === undefined ? card : section(group.id, group.heading, card, "form-section");
  });
  const refused = options.errors.length > 0;
  return renderPage({
    title: refused ? `Error: ${options.title}` : options.title,
    description: options.description,
    current: options.current,
    frame: ctx,
    body: html`<p class="back"><a href="${options.back.href}">${options.back.text}</a></p>
<h1>${options.heading}</h1>
<p class="lede">${options.lede}</p>
${formErrorSummary(options.errors, specs, options.prefix)}
${anyOutside(options.shown) ? outsideNote() : ""}
${postForm(
  "record-form",
  options.action,
  { csrf: ctx.csrf, here: options.cancel },
  html`
${cards}
<div class="form-actions">
<button class="button" type="submit">${options.submit}</button>
<a class="form-cancel" href="${options.cancel}">Cancel</a>
</div>
`,
  { novalidate: true },
)}`,
  });
}
