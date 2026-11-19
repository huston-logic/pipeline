// /deals/<id>/edit: a deal's title, value, next step and date, and custom deal fields (update_deal). The stage stays on
// the Move to form. Only the fields the owner changes are saved (decision 0018).
import { getDeal, listFieldDefs } from "../../db/queries.ts";
import { dealTitle, isTrusted } from "../../services/labels.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import type { PageContext } from "../context.ts";
import { dealHref } from "../parts.ts";
import { dealSpecs, editShown } from "../record-form.ts";
import { anyOutside } from "../record-fields.ts";
import { OUTSIDE_STAYS } from "./contact-edit.ts";
import { type FormState, recordFormPage } from "./record-page.ts";

export const dealEditPath = (id: string): string => `${dealHref(id)}/edit`;

export async function dealEditPage(ctx: PageContext, id: string, state?: FormState): Promise<string | null> {
  const deal = await getDeal(ctx.db, id);
  if (deal === null) return null;
  const specs = dealSpecs(await listFieldDefs(ctx.db), { titleRequired: true, notes: false });
  const shown = state?.shown ?? (await editShown(specs, deal, await ownerTimezone(ctx.db)));
  // The title, or "deal dl_…" when it came from outside.
  const name = isTrusted(deal, "title") ? deal.title : dealTitle(deal);
  const back = dealHref(deal.id);
  const outside = anyOutside(shown) ? ` ${OUTSIDE_STAYS}` : "";
  return recordFormPage(ctx, {
    title: `Edit ${name}`,
    description: `Change the title, value, next step and custom fields of ${name}.`,
    heading: `Edit ${name}`,
    lede: `Change what you need and save. To move it to another stage, use Move to on the deal page.${outside}`,
    current: dealEditPath(deal.id),
    back: { href: back, text: "Back to the deal" },
    action: dealEditPath(deal.id),
    cancel: back,
    submit: "Save changes",
    prefix: "deal",
    groups: [{ specs }],
    shown,
    errors: state?.errors ?? [],
  });
}
