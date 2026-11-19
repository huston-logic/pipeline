import type { Actor, Db } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type ChangeItem, changeLog, CHANGE_LOG_DAYS } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { renderPage } from "../layout.ts";
import { empty, fact, meta, when } from "../parts.ts";

const BY: Record<Actor, string> = { owner: "You", ai: "Your AI app", system: "The system" };

function changeItem(change: ChangeItem, tz: string): Html {
  const undone =
    change.undone && change.undoneAt !== null
      ? fact(
          "Undone",
          html`${when(change.undoneAt, formatLocal(change.undoneAt, tz))}${change.undoneBy ? ` by change ${change.undoneBy}` : ""}`,
        )
      : null;
  return html`<li>
<p class="item-title">${change.undone ? html`<span class="flag">Undone</span> ` : ""}${change.summary}</p>
${meta([
  fact("When", when(change.at, formatLocal(change.at, tz))),
  fact("By", BY[change.actor]),
  fact("Change id", change.changeId),
  change.undoOf !== null && fact("Undid", `change ${change.undoOf}`),
  undone,
])}
</li>`;
}

export async function changesPage(db: Db, now: Date): Promise<string> {
  const tz = await ownerTimezone(db);
  const log = await changeLog(db, now);
  const body =
    log.changes.length === 0
      ? empty(`No changes in the last ${CHANGE_LOG_DAYS} days. Changes made through your AI app, your rules and your website form show up here.`)
      : html`<ul class="items">${log.changes.map((change) => changeItem(change, tz))}</ul>
${log.truncated ? html`<p class="note">Showing the newest ${log.changes.length}. Ask your AI app for older changes.</p>` : ""}`;
  return renderPage({
    title: "Changes · Pipeline",
    description: `Every change from the last ${CHANGE_LOG_DAYS} days, newest first, with the ones that were undone marked.`,
    current: "/changes",
    body: html`<h1>Changes</h1>
<p class="lede">The last ${CHANGE_LOG_DAYS} days, newest first. To undo one, ask your AI app and give it the change id.</p>
${body}`,
  });
}
