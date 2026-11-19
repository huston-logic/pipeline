import type { Actor, Db } from "../../db/db.ts";
import { ownerTimezone } from "../../services/lookup.ts";
import { type ChangeItem, changeLog, CHANGE_LOG_DAYS } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import { type Look, renderPage } from "../layout.ts";
import { empty, pairs, tag, when } from "../parts.ts";

const BY: Record<Actor, string> = { owner: "You", ai: "Your AI app", system: "The system" };

function changeItem(change: ChangeItem, tz: string): Html {
  return html`<li>
<p class="row-text">${change.undone ? html`${tag("Undone", true)} ` : ""}${change.summary}</p>
${pairs([
  { name: "When", value: when(change.at, formatLocal(change.at, tz)) },
  { name: "By", value: BY[change.actor] },
  { name: "Change id", value: change.changeId },
  change.undoOf !== null && { name: "Undid", value: `change ${change.undoOf}` },
  change.undone &&
    change.undoneAt !== null && {
      name: "Undone",
      value: html`${when(change.undoneAt, formatLocal(change.undoneAt, tz))}${change.undoneBy ? ` by change ${change.undoneBy}` : ""}`,
    },
])}
</li>`;
}

export async function changesPage(db: Db, now: Date, look: Look): Promise<string> {
  const tz = await ownerTimezone(db);
  const log = await changeLog(db, now);
  const body =
    log.changes.length === 0
      ? empty(
          `No changes in the last ${CHANGE_LOG_DAYS} days.`,
          "Changes made through your AI app, your rules and your website form show up here.",
        )
      : html`<ul class="panel rows changes">${log.changes.map((change) => changeItem(change, tz))}</ul>
${log.truncated ? html`<p class="note">Showing the newest ${log.changes.length}. Ask your AI app for older changes.</p>` : ""}`;
  return renderPage({
    title: "Changes",
    description: `Every change from the last ${CHANGE_LOG_DAYS} days, newest first, with the ones that were undone marked.`,
    current: "/changes",
    look,
    body: html`<h1>Changes</h1>
<p class="lede">The last ${CHANGE_LOG_DAYS} days, newest first. To undo one, ask your AI app and give it the change id.</p>
${body}`,
  });
}
