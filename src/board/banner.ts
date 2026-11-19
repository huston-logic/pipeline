// The change banner (decisions 0014, 0017): a board page opened with ?change=<id> shows that change's one-line summary
// in a status region, with an Undo button unless the change is an undo itself or was already undone. Summaries never
// carry outside text (services name records through src/services/labels.ts), so they are shown as they are.
import type { Db } from "../db/db.ts";
import { isChangeId } from "../ids.ts";
import { type ChangeItem, getChange } from "../services/read.ts";
import type { FormContext } from "./forms.ts";
import { postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";

export const undoAction = (changeId: string): string => `/changes/${encodeURIComponent(changeId)}/undo`;

/** Undo can be tried on this change (it may still refuse, for example when the record changed since). */
export const canUndo = (change: Pick<ChangeItem, "undone" | "undoOf">): boolean => !change.undone && change.undoOf === null;

/** The Undo button as its own form. The hidden words tell a screen reader which change it undoes. */
export function undoForm(changeId: string, form: FormContext, className: string): Html {
  return postForm(
    className,
    undoAction(changeId),
    form,
    html`<button class="button button-quiet" type="submit">Undo<span class="visually-hidden"> change ${changeId}</span></button>`,
  );
}

export async function changeBanner(db: Db, query: URLSearchParams, form: FormContext): Promise<Html | ""> {
  const id = query.get("change");
  if (id === null || !isChangeId(id)) return "";
  const change = await getChange(db, id);
  if (change === null) return "";
  const after = change.undone
    ? html`<p class="banner-note">This change was undone.</p>`
    : canUndo(change)
      ? undoForm(change.changeId, form, "banner-form")
      : "";
  return html`<div class="banner" role="status">
<p class="banner-text">${change.summary}</p>
${after}
</div>`;
}
