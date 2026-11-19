# 0015: The board's look, its navigation, and the owner's name and accent colour

Run 2, task R1, 2026-11-18. Builds on 0013 (board pages, outside text) and 0014 (editable board); replaces 0013's
"no cards" and "two columns from 60rem" mobile notes.

## Context

The owner found the board ugly and could not find contacts or companies. The board is the demo and the owner's daily
screen, used on a phone. The run 2 brief asked for a finished look built on the Huston Logic v3 style guide, phone
navigation (bottom tabs) and a side bar on wide screens, and made the business name and accent colour settings. It
left open how v3 (a marketing website guide) becomes an app, how the accent reaches the page under a CSP with no
inline styles, which accents are allowed, the breakpoint, how "More" works without JavaScript, and what Today, Pipeline
and Contacts show before tasks R2 and R3.

## Decision

- **Design system.** `docs/STYLE-GUIDE.md` is filled in as the board's design system: v3's palette values, contrast
  table, radius scale, green-tinted shadows, rust focus ring, sentence case, slow underline and banned list. Stated
  departures: system fonts only (headings ask for `ui-rounded` first); no hero, doors, arc, ring, card stack, tilt or
  second voice; cards for records (deal, task, contact, rule); one faint glow at the top right of the content. The
  outside-text block loses its left border (v3 bans left-border callouts): it is a quiet `--silver-2` panel with the
  "From outside" label in words.
- **Tokens.** `public/board.css` keeps the AGENTS.md token names with v3 values (`--green` is now `#2b6455`, not blue)
  and adds `--accent` (default `var(--green)`), `--accent-tint` (`color-mix` of 12% accent on white) and
  `--on-accent` (white). Components use `--accent` for brand accents: the current tab, primary buttons, card-title
  links and links. Accent text sits only on white or silver; text on `--accent-tint` is `--ink`.
- **Settings.** Migration `0004_settings_look.sql` adds nullable `business_name` (1 to 60 characters) and
  `accent_color` (`#rrggbb`, lower case) to `settings`, with CHECK constraints. `update_settings` takes `businessName`
  (trimmed, one line, null or blank clears) and `accentColor` (null clears); `get_settings` shows both. Both are
  owner-set, audited and undoable like the other settings.
- **Accent contrast rule** (`src/services/accent.ts`). A colour is refused unless white text on it, it as text on
  white, and it as text on the page silver all reach 4.5:1 (WCAG AA body text). The refusal says the ratio it has and
  "Pick a darker colour." The silver value is checked against `board.css` by a test.
- **`/theme.css`.** The CSP is `style-src 'self'`, so the accent arrives as a stylesheet the Worker writes:
  `:root{--accent:#…;}`, or a one-line comment when unset or unusable. It is matched before the static-file branch,
  sits behind the same sign-in as the board pages, and answers `text/css`, `no-store`, with the security headers. The
  stored value is checked again (format and contrast) before it is written, so nothing else can reach the stylesheet.
  Signed-in board pages link it after `/board.css`; pages drawn without a sign-in or settings (the static 404 and
  index pages, the 404 for an unknown path, the sign-in pages) do not, and show "Pipeline".
- **Navigation.** One `<nav aria-label="Board pages">` inside the header. Under 60rem (960px) it is a fixed bottom tab
  bar (Today, Pipeline, Contacts, Brief, More: line icon plus label, 60px tall, safe-area inset, `viewport-fit=cover`,
  `scroll-padding-bottom` so focus is never under it) under a white app bar with the monogram and business name. From
  60rem it is a sticky 16rem side bar with the same items and Rules, Changes and Export listed under More. The current
  page is `aria-current="page"`; the section of a page that is not itself a nav item is `aria-current="true"` (More for
  Rules, Changes and Export; Pipeline for a deal page).
- **"More" link text.** Lighthouse's SEO audit fails a link whose whole text is "More", so the link carries a
  visually hidden " pages": people see "More", assistive technology reads "More pages" (the visible label still starts
  the name, WCAG 2.5.3).
- **`/more`** is a real page (works without JavaScript, no popover) listing Rules, Changes and Export as link cards
  with one-line descriptions.
- **Pages.** `/` is Today: the owner's date, a summary sentence, Overdue and Due today as cards, then the open stages
  with counts (each a link to that stage on `/pipeline`) and the latest brief excerpt. `/pipeline` lists open deals by
  stage as cards (R3 makes it a kanban). `/contacts` lists every contact that is not archived, by name, with company,
  open-deal count, last activity (newest activity on the contact or any of their deals, `listContacts` in
  `src/services/read.ts`) and links to their open deals (R2 adds search, sort and contact pages). Page titles are
  "<page> · <business name>" (the middle dot from 0013). Empty states say what is missing and how things get added (by
  talking to the AI app); they promise no buttons until R3/R4. The footer says "Changes are made by talking to your AI
  app."
- **Breakpoints.** 40rem: card grids. 60rem: side bar. 72rem: Today and the deal page in two columns.
- **Screenshots.** `npm run screenshots` (`playwright.screenshots.config.ts`, `tests/screenshots/board.screens.ts`)
  drives the installed Google Chrome (channel `chrome`, no download) against `npm run preview`, saves every board route
  at 375 and 1280 px wide to `.owner-review/screenshots/`, and fails on axe violations (the a11y check's tags) or
  horizontal scroll. CI does not run it.

## Why

- Cards for records and rows for lines follow v3's own rule ("only objects get boxes") and read well on a phone in
  sunlight: one white object per thing to act on, with a clear title.
- A bottom tab bar is where a thumb is; five items fit at 375px with labels. "More" as a page keeps the board free of
  JavaScript for navigation and keeps every page reachable from every page.
- Checking the accent on input and again at output means an owner can brand their copy without ever making the
  board unreadable, and no value written around the service can inject CSS.
- One nav element with two layouts keeps one landmark and one set of links, so screen readers and tests see the same
  thing at every width.

## Consequences

- `boardRoutes` grows to ten pages, so the a11y and Lighthouse checks take longer (Lighthouse runs five times per
  route).
- `color-mix()` needs Chrome 111, Safari 16.2 or Firefox 113; older browsers lose only the tint behind the current
  tab.
- `renderPage` now appends the business name to every title; callers pass the page's own title only.
- Tests that matched the old markup were updated to the new markup; they still check escaping, the "From outside"
  labels, one `<h1>`, landmarks and headers.

## "AI defaults" (human-touch-design), flagged for the owner

- **Rounded cards with one soft shadow on every record** (item 4, the SaaS-card kit). Required by the brief ("cards
  for deals and tasks"); radii and shadows follow v3's scale, and lines of a document are rows, not cards.
  Alternatives: cards only on Today and Pipeline, with Contacts and Rules as rows on one panel; or flat cards with a
  border and no shadow.
- **Monogram tile** (the business name's first letter on an accent square) as the only logo. Free choice.
  Alternatives: the business name alone in the display face; or a small accent dot before the name.
- **Middle dot in page titles** ("Today · Fernwood…", item 5): kept from 0013 and named in the brief.
  Alternatives: "Today | Fernwood…"; or "Fernwood… today".
- **Count beside each stage name** ("2 deals, value 3,900") in `ink-2` at the right edge. Free choice.
  Alternatives: the count as a tag after the stage name; or counts only on Today.
- **Bottom tab bar with a pill behind the current icon** (a common mobile pattern). Required by the brief (bottom
  tabs); the pill is my choice. Alternatives: the current tab in accent with no pill; or a 3px accent bar above the
  current tab.
- **One faint glow at the top right.** Allowed by the brief if it reads well. Alternative: no glow, plain silver.
- Not used: eyebrow labels, all caps, monospace ids or file names, arrows on links, big-number stat tiles, gradient
  washes, hover lift on cards.
