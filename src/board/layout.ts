import { type Html, html } from "./html.ts";
import { navItems } from "./routes.ts";

export type PageOptions = {
  title: string;
  description: string;
  body: Html;
  /** Path of the page being shown; its nav link gets aria-current. Leave out on pages outside the nav. */
  current?: string;
};

function nav(current: string | undefined): Html {
  const links = navItems.map(
    (item) =>
      html`<li><a href="${item.href}"${item.href === current ? html` aria-current="page"` : ""}>${item.label}</a></li>`,
  );
  return html`<nav aria-label="Board pages"><ul>${links}</ul></nav>`;
}

/** A full board document. The page body supplies the single <h1>. */
export function renderPage({ title, description, body, current }: PageOptions): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/board.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap">
<p class="brand">Pipeline</p>
${nav(current)}
</div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="site-footer">
<div class="wrap">
<p>Read-only view. Make changes by talking to your AI app.</p>
</div>
</footer>
</body>
</html>
`.value;
}
