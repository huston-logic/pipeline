// Undo on the board (decisions 0014, 0017): the Undo button as its own form, and whether a change may offer it. The
// status corner (corner.ts) shows a page's ?change=<id> with this button, unless the change is an undo itself or was
// already undone.
import type { ChangeItem } from "../services/read.ts";
import { CAMPAIGN_FINAL_TOOLS } from "../services/undo.ts";
import type { FormContext } from "./forms.ts";
import { postForm } from "./forms.ts";
import { type Html, html } from "./html.ts";

export const undoAction = (changeId: string): string => `/changes/${encodeURIComponent(changeId)}/undo`;

/**
 * Undo can be tried on this change (it may still refuse, for example when the record changed since). A campaign's
 * sending steps and an unsubscribe never offer it: undo_change refuses them (CAMPAIGN_FINAL_TOOLS).
 */
export const canUndo = (change: Pick<ChangeItem, "undone" | "undoOf" | "tool">): boolean =>
  !change.undone && change.undoOf === null && !(CAMPAIGN_FINAL_TOOLS as readonly string[]).includes(change.tool);

/** The Undo button as its own form. The hidden words tell a screen reader which change it undoes. */
export function undoForm(changeId: string, form: FormContext, className: string): Html {
  return postForm(
    className,
    undoAction(changeId),
    form,
    html`<button class="button button-quiet" type="submit">Undo<span class="visually-hidden"> change ${changeId}</span></button>`,
  );
}

