import type { ChangeItem } from "../../services/read.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { changeLog, CHANGE_LOG_DAYS } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { canUndo, undoForm } from "../banner.ts";
import type { PageContext } from "../context.ts";
import type { FormContext } from "../forms.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty, pairs, tag, when } from "../parts.ts";

/** Who made a change, in words, from its actor and tool (decision 0017). */
export function changedBy(change: Pick<ChangeItem, "actor" | "tool">): string {
  if (change.actor === "ai") return "Your AI app";
  if (change.actor === "owner") return change.tool === "import" ? "You, by a CSV import" : "You, on the board";
  return change.tool === "intake" ? "Your website form" : "System";
}

function changeItem(change: ChangeItem, tz: string, form: FormContext): Html {
  return html`<li>
<p class="row-text">${change.undone ? html`${tag("Undone", true)} ` : ""}${change.summary}</p>
${pairs([
  { name: "When", value: when(change.at, formatLocal(change.at, tz)) },
  { name: "By", value: changedBy(change) },
  { name: "Change id", value: change.changeId },
  change.undoOf !== null && { name: "Undid", value: `change ${change.undoOf}` },
  change.undone &&
    change.undoneAt !== null && {
      name: "Undone",
      value: html`${when(change.undoneAt, formatLocal(change.undoneAt, tz))}${change.undoneBy ? ` by change ${change.undoneBy}` : ""}`,
    },
])}
${canUndo(change) ? undoForm(change.changeId, form, "row-form") : ""}
</li>`;
}

export async function changesPage(ctx: PageContext): Promise<string> {
  const { db, now } = ctx;
  const tz = await ownerTimezone(db);
  const log = await changeLog(db, now);
  const body =
    log.changes.length === 0
      ? empty(
          `No changes in the last ${CHANGE_LOG_DAYS} days.`,
          "Changes you make here or through your AI app, and the ones your rules and your website form make, show up here.",
        )
      : html`<ul class="panel rows changes">${log.changes.map((change) => changeItem(change, tz, ctx))}</ul>
${log.truncated ? html`<p class="note">Showing the newest ${log.changes.length}. Ask your AI app for older changes.</p>` : ""}`;
  return renderPage({
    title: "Changes",
    description: `Every change from the last ${CHANGE_LOG_DAYS} days, newest first, with the ones that were undone marked.`,
    current: "/changes",
    frame: ctx,
    body: html`<h1>Changes</h1>
<p class="lede">The last ${CHANGE_LOG_DAYS} days, newest first. Undo a change here, or ask your AI app and give it the change id.</p>
${body}`,
  });
}
