import { type BriefItem, type BriefSection, headerDate, SECTION_TITLES } from "../../brief/compose.ts";
import { getSettings } from "../../db/queries.ts";
import { type BriefView, latestBrief } from "../../services/read.ts";
import { formatLocal } from "../../time.ts";
import { type Html, html } from "../html.ts";
import type { PageContext } from "../context.ts";
import { renderPage } from "../layout.ts";
import { empty, labelled, when } from "../parts.ts";

export const briefDate = (localDate: string) => headerDate(localDate);

/** The stored line without its "- " list marker. */
export const briefLine = (item: BriefItem) => item.line.replace(/^- /, "");

/** Whether the brief was emailed, in plain words (decision 0011 lists the stored values). */
export function sendStatusText(brief: Pick<BriefView, "sendStatus" | "sentAt">): string {
  const status = brief.sendStatus;
  if (status === "sent") return "It was emailed to you.";
  if (status === null) return "It was not emailed.";
  if (status === "pending") return "The email may not have gone: the send did not finish, and it is not retried.";
  if (status.startsWith("off: ")) return `It was not emailed, because sending is off (${status.slice(5)}).`;
  if (status.startsWith("failed: ")) return `The email failed (${status.slice(8)}). It is not retried; tomorrow's brief tries again.`;
  return `Email status: ${status}.`;
}

function section(name: BriefSection, items: BriefItem[]): Html | "" {
  const mine = items.filter((item) => item.section === name);
  if (mine.length === 0) return "";
  return html`<section class="brief-section" aria-labelledby="brief-${name}">
<h2 id="brief-${name}">${SECTION_TITLES[name]}</h2>
<ul class="panel rows">${mine.map((item) => html`<li>${labelled(briefLine(item), item.untrusted)}</li>`)}</ul>
</section>`;
}

function briefBody(brief: BriefView, tz: string): Html {
  const sections = (Object.keys(SECTION_TITLES) as BriefSection[]).map((name) => section(name, brief.items));
  const outside = brief.items.some((item) => item.untrusted);
  return html`<p class="lede">For ${briefDate(brief.localDate)}. Composed ${when(brief.composedAt, formatLocal(brief.composedAt, tz))}.</p>
<p class="section-note">${sendStatusText(brief)}</p>
${outside ? html`<p class="note">Lines marked From outside include text from a website form or an import, shown as received.</p>` : ""}
${brief.items.length === 0 ? empty("Nothing was due that day.") : sections}`;
}

export async function briefPage(ctx: PageContext): Promise<string | null> {
  if (ctx.brief !== true) return null;
  const { db } = ctx;
  const settings = await getSettings(db);
  const brief = await latestBrief(db);
  const body =
    brief === null
      ? empty(
          "No brief yet.",
          `The first one is composed at ${settings.brief_hour}:00 (${settings.timezone} time) and shows up here.`,
        )
      : briefBody(brief, settings.timezone);
  return renderPage({
    title: "Daily brief",
    description: "The latest daily brief: overdue and due-today tasks, quiet deals and new leads, and whether it was emailed.",
    current: "/brief",
    frame: ctx,
    body: html`<h1>Daily brief</h1>
${body}`,
  });
}
