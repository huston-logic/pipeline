// The board's page frame (docs/STYLE-GUIDE.md §7): an app bar and a fixed tab bar on phones, a side bar on wide
// screens. Both are one <nav>; CSS lays it out for the width. The page body supplies the single <h1>.
import type { SettingsRow } from "../db/db.ts";
import { isUsableAccent } from "../services/accent.ts";
import { type Html, html, raw } from "./html.ts";
import { icon } from "./icons.ts";
import { moreItemsFor, type NavItem, navItems } from "./routes.ts";
import { type TimerInfo, timerBar } from "./timer-bar.ts";

/**
 * What a copy's owner set for the board's look. The accent reaches the stylesheet separately, as /theme.css; here it
 * is only the phone's theme colour (decision 0019), checked like /theme.css checks it.
 */
export type Look = { name: string; themeColor?: string };

export const DEFAULT_NAME = "Pipeline";

export const FOOTER = "Add leads, edit contacts and deals, and move, log and undo here, or change anything by talking to your AI app.";

/** The --green token in public/board.css, the accent's default (a test keeps the two in step). */
export const DEFAULT_THEME_COLOR = "#2b6455";

/** A usable stored accent, or the default green. */
export function themeColorOf(accent: string | null): string {
  return isUsableAccent(accent) ? accent : DEFAULT_THEME_COLOR;
}

/** A phone shows about 12 characters under a home-screen icon, so a longer business name gives way to Pipeline. */
export function shortNameOf(name: string): string {
  return [...name].length <= 12 ? name : DEFAULT_NAME;
}

export function lookOf(settings: Pick<SettingsRow, "business_name" | "accent_color">): Look {
  return { name: settings.business_name ?? DEFAULT_NAME, themeColor: themeColorOf(settings.accent_color) };
}

/** The tags that let a phone add a signed-in board to its home screen (decision 0019). */
function appTags(look: Look): Html {
  return html`<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<meta name="theme-color" content="${look.themeColor ?? DEFAULT_THEME_COLOR}">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="${shortNameOf(look.name)}">
`;
}

/** What the router hands every signed-in page's frame: the owner's look and the change banner (decision 0017). */
export type PageFrame = { look: Look; banner?: Html | ""; /** The running timer, for the Stop bar (decision 0050). */ timer?: TimerInfo | null; /** Time tracking is on, so More lists Time (decision 0051). */ timeTracking?: boolean; /** Campaigns are on, so More lists Campaigns (decision 0053). */ campaigns?: boolean; /** Projects are on, so More lists Projects (decision 0055). */ projects?: boolean };

export type PageOptions = {
  /** The page's own title; the layout adds " · <business name>". */
  title: string;
  description: string;
  body: Html;
  /** Path of the page being shown; its nav link gets aria-current. Leave out on pages outside the nav. */
  current?: string;
  /** The owner's look and the change banner, on signed-in pages. Without it (404, static and sign-in pages) the board
   * says "Pipeline" and links no /theme.css, which needs a sign-in. */
  frame?: PageFrame;
  /** Loads /board.js (decision 0014): only pages whose forms it enhances. "push" loads /push.js instead, on the
   * Notifications page only (decision 0030). */
  script?: boolean | "push";
};

function scriptTag(script: boolean | "push"): Html | "" {
  if (script === "push") return html`<script src="/push.js" defer></script>\n`;
  return script ? html`<script src="/board.js" defer></script>\n` : "";
}

/** The nav item a page belongs to without being it: a deal is in Pipeline; a contact, Leads, a new lead, Companies
 * and the People views (/people, decision 0042) are in People; Rules, Changes, Export, Notifications and Email
 * logging are in More. */
function sectionOf(path: string): string | null {
  if (path.startsWith("/deals/")) return "/pipeline";
  const people = ["/companies", "/leads", "/people"];
  if (path.startsWith("/contacts/") || people.includes(path) || path.startsWith("/leads/")) return "/contacts";
  const inMore = ["/time/", "/campaigns/", "/projects/"].some((prefix) => path.startsWith(prefix));
  if (moreItemsFor({ timeTracking: true, campaigns: true, projects: true }).some((item) => item.href === path) || inMore) {
    return "/more";
  }
  return null;
}

function link(item: NavItem, current: string | undefined): Html {
  const state =
    current === undefined
      ? ""
      : item.href === current
        ? html` aria-current="page"`
        : item.href === sectionOf(current)
          ? html` aria-current="true"`
          : "";
  const hint = item.hint === undefined ? "" : html`<span class="visually-hidden">${item.hint}</span>`;
  return html`<a href="${item.href}"${state}>${icon(item.icon)}<span class="nav-label">${item.label}</span>${hint}</a>`;
}

function nav(current: string | undefined, on: { timeTracking: boolean; campaigns: boolean; projects: boolean }): Html {
  const items = navItems.map((item) =>
    item.href === "/more"
      ? html`<li class="nav-more">${link(item, current)}
<ul class="nav-sub">${moreItemsFor(on).map((sub) => html`<li>${link(sub, current)}</li>`)}</ul>
</li>`
      : html`<li>${link(item, current)}</li>`,
  );
  return html`<nav class="app-nav" aria-label="Board pages">
<ul class="nav-main">
${items}
</ul>
</nav>`;
}

/** The first letter of the business name, for the monogram tile. */
const initial = (name: string) => ([...name.trim()][0] ?? "P").toUpperCase();

/**
 * The page body with the change banner right after its h1, so a screen reader meets it straight after the heading.
 * Both are markup this repo wrote (data inside the h1 is escaped, so its closing tag can only be the page's own).
 */
function withBanner(body: Html, banner: Html | "" | undefined): Html {
  if (!banner) return body;
  const end = body.value.indexOf("</h1>");
  if (end < 0) return html`${banner}\n${body}`;
  const split = end + "</h1>".length;
  return html`${raw(body.value.slice(0, split))}\n${banner}${raw(body.value.slice(split))}`;
}

export function renderPage({ title, description, body, current, frame, script = false }: PageOptions): string {
  const name = frame?.look.name ?? DEFAULT_NAME;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · ${name}</title>
<meta name="description" content="${description}">
<link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32">
<link rel="stylesheet" href="/board.css">
${frame ? html`<link rel="stylesheet" href="/theme.css">\n${appTags(frame.look)}` : ""}${scriptTag(script)}</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="app">
<header class="app-header">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">${initial(name)}</span><span class="brand-name">${name}</span></a>
${nav(current, { timeTracking: frame?.timeTracking === true, campaigns: frame?.campaigns === true, projects: frame?.projects === true })}
</header>
<div class="app-body">
${frame?.timer ? timerBar(frame.timer) : ""}<main id="main">
${withBanner(body, frame?.banner)}
</main>
<footer class="app-footer">
<p>${FOOTER}</p>
</footer>
</div>
</div>
</body>
</html>
`.value;
}
