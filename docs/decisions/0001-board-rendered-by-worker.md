# 0001: The board is HTML rendered by the Worker; Next.js is removed

Replaced in part by 0014 (run 2): the board is now editable and may load one small first-party script as
progressive enhancement. Server rendering, the `html` tag and the removal of Next.js still stand.

## Context

The repo started as a Next.js static-export website. The spec needs a read-only board that shows live D1 data behind
Cloudflare Access, and one Worker that also serves `/mcp`, `/intake` and `/api/*`. The spec left open how the board is
built.

## Decision

The Worker renders the board as plain HTML on each request (`src/board/`: an escaping `html` template tag, one
`renderPage` layout, one module per page). There is no client JavaScript, no React and no framework. Next.js, React,
React DOM, Tailwind and `eslint-config-next` are removed; `typescript-eslint` replaces the Next.js lint config.

`npm run build` (`scripts/build.mjs`) now only writes the static files the Worker serves through its `ASSETS` binding:
`public/` (stylesheet, `robots.txt`, `_headers`) plus `out/index.html` (a "board not running" notice), `out/404.html`
and `out/sitemap.xml`, which CI checks for.

Styling is one stylesheet, `public/board.css`. Its `:root` custom properties copy the palette values from the template's
`src/app/hl.css` (silver, ink, green, rust, tint, line, ...). Fonts are the system stack; no web fonts.

## Why

- The data is live and private. A static export would need client-side fetching from `/api`, which means client
  JavaScript, a loading state and a second way to render every view.
- Server rendering ships zero JavaScript, so the CSP can say `script-src 'none'`, Lighthouse stays fast without effort,
  and there is one deployable (the Worker plus its static files).
- Fewer dependencies: the runtime has none.

## Consequences

- No interactivity on the board beyond links and native HTML (`<details>`, forms that use GET). That fits v1, which is
  read-only apart from export.
- Every interpolation must go through `html` so data is escaped; `raw()` is only for markup written in this repo.
- The accessibility and Lighthouse checks run against `wrangler dev --local` (`npm run preview`), not a static server.
- `docs/STYLE-GUIDE.md` and the hooks' style rules come from the website; they still apply where they make sense
  (tokens in CSS, focus ring, contrast), but there is no hero or first-screen spec for the board.
