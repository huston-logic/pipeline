# 0019: The board installs to a phone home screen

Run 2, task R6, 2026-11-19. Builds on 0014 (editable board; it said the manifest link needs credentials) and 0015
(business name, accent colour, `/theme.css`). Number 0018 is left for task R4, whose PR was not open yet.

## Context

The owner uses the board on a phone every day and wants it on the home screen like an app. The run 2 brief asked for
a web app manifest named after the business, icons and a favicon. It left open where the manifest comes from (the name
and colour are per-copy settings, and the repo holds no client data), how the browser fetches it behind Cloudflare
Access, what the icon shows, and whether to add a service worker for offline use.

## Decision

- **Worker-served manifest.** `/manifest.webmanifest` is written by the Worker from the settings (`src/board/manifest.ts`),
  like `/theme.css`: matched before the static-file branch, behind the board's sign-in, with the security headers,
  `Content-Type: application/manifest+json` and `Cache-Control: no-store`. It is built as an object and serialised
  with `JSON.stringify`, never by joining strings. `name` is the business name (default "Pipeline"); `short_name` is
  the business name when it has 12 characters or fewer, else "Pipeline", because a phone shows about 12 characters
  under an icon; `id`, `start_url` and `scope` are `/`; `display` is `standalone`; `background_color` is the page
  silver; `theme_color` is the accent, checked again as `/theme.css` checks it, or the default green.
- **Credentials.** Browsers fetch a manifest without cookies unless its link says otherwise, so behind Access the fetch
  would get the Access sign-in page instead. The layout links it with `crossorigin="use-credentials"`.
- **Head tags.** Signed-in board pages (those drawn with the owner's look) link the manifest and add
  `<meta name="theme-color">` (the accent or the default green), `<link rel="apple-touch-icon">` and
  `<meta name="apple-mobile-web-app-title">` (the short name). Every page, the static 404 and index pages too, links
  the favicon (`/icons/favicon-32.png`) instead of the old `data:,` placeholder. No inline style or script.
- **Generic icon.** Every copy runs the same code, so the icon is not any company's logo: a rounded square in the
  `--green` token with a white glyph of three board columns (bars of different heights). `scripts/make-icons.mjs`
  draws it with Node built-ins only and writes `public/icons/`: `icon-192.png` and `icon-512.png` (purpose `any`,
  see-through corners), `icon-maskable-512.png` (full square; glyph inside the central 80% safe zone),
  `apple-touch-icon.png` (180 px, opaque; iOS rounds it) and `favicon-32.png`. The script compresses the PNGs itself
  (fixed Huffman codes, runs only) instead of using zlib, because zlib's output can differ between Node versions and
  CPUs; a test checks the committed files are byte-identical to the script's output, so they cannot drift, and that
  zlib can read them. The icon stays green when the owner sets another accent (the files are static).
- **No service worker.** Nothing is cached on the phone for offline use: the board holds private sales data, and a
  cached page could outlive a sign-out or show stale deals. A test fails if anything in `public/` or `src/` registers
  a service worker.

## What a phone shows

- **iPhone (Safari):** Share, then Add to Home Screen. The icon is the green board tile, the label is the short name,
  and the board opens full screen without Safari's address bar.
- **Android (Chrome):** the menu (three dots), then Install app or Add to Home screen. Chrome uses the 512 px maskable
  icon in the phone's icon shape, the business name on the splash screen over the silver background, and the accent
  in the status bar.
- Opening it still goes through Cloudflare Access when the Access session has expired; with no network it shows the
  browser's own offline page.

## Why

- Serving the manifest from the Worker keeps per-copy names and colours in D1 (decision 0002) and reuses the checked
  path `/theme.css` already proved.
- A code-drawn icon keeps the repo free of anything client-specific and makes the icons reproducible.
- Without a service worker there is nothing to invalidate and no private data at rest on the phone.

## Consequences

- Changing the business name or accent changes the installed app's name and colour only when the phone re-reads the
  manifest (Android does this now and then; iOS keeps what it saw when the icon was added).
- Changing the icon means editing `scripts/make-icons.mjs`, running `node scripts/make-icons.mjs` and committing the
  PNGs; the test fails until both agree.
- No offline use. A later decision can add a service worker that caches only the static files, never pages or data.
