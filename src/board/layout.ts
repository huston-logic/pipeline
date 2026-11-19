// The board's page frame (docs/STYLE-GUIDE.md §7): an app bar and a fixed tab bar on phones, a side bar on wide
// screens. Both are one <nav>; CSS lays it out for the width. The page body supplies the single <h1>.
import type { SettingsRow } from "../db/db.ts";
import { type Html, html } from "./html.ts";
import { icon } from "./icons.ts";
import { moreItems, type NavItem, navItems } from "./routes.ts";

/** What a copy's owner set for the board's look. The accent arrives separately, as /theme.css. */
export type Look = { name: string };

export const DEFAULT_NAME = "Pipeline";

export function lookOf(settings: Pick<SettingsRow, "business_name">): Look {
  return { name: settings.business_name ?? DEFAULT_NAME };
}

export type PageOptions = {
  /** The page's own title; the layout adds " · <business name>". */
  title: string;
  description: string;
  body: Html;
  /** Path of the page being shown; its nav link gets aria-current. Leave out on pages outside the nav. */
  current?: string;
  /** The owner's look, on signed-in pages. Without it (404, static and sign-in pages) the board says "Pipeline" and
   * links no /theme.css, which needs a sign-in. */
  look?: Look;
};

/** The nav item a page belongs to without being it: a deal is in Pipeline; Rules, Changes and Export are in More. */
function sectionOf(path: string): string | null {
  if (path.startsWith("/deals/")) return "/pipeline";
  if (moreItems.some((item) => item.href === path)) return "/more";
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

function nav(current: string | undefined): Html {
  const items = navItems.map((item) =>
    item.href === "/more"
      ? html`<li class="nav-more">${link(item, current)}
<ul class="nav-sub">${moreItems.map((sub) => html`<li>${link(sub, current)}</li>`)}</ul>
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

export function renderPage({ title, description, body, current, look }: PageOptions): string {
  const name = look?.name ?? DEFAULT_NAME;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · ${name}</title>
<meta name="description" content="${description}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/board.css">
${look ? html`<link rel="stylesheet" href="/theme.css">\n` : ""}</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="app">
<header class="app-header">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">${initial(name)}</span><span class="brand-name">${name}</span></a>
${nav(current)}
</header>
<div class="app-body">
<main id="main">
${body}
</main>
<footer class="app-footer">
<p>Changes are made by talking to your AI app.</p>
</footer>
</div>
</div>
</body>
</html>
`.value;
}
