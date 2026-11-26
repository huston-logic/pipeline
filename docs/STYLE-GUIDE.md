# Pipeline board: Design System (style guide)

> The design system for the board every client copy shows. The `human-touch-design` skill, the `scan-src` hook and
> the code comments read this file by section number, so keep the headings and numbers. Version: 1 (run 2, task R1,
> 2026-11-18; decision 0015).

## 1. Direction

The board is the owner's daily screen and the demo of the product: a small-business owner opens it on a phone between
jobs, often outside, and must see in a few seconds what is due, who is waiting and what changed. It should look like
a finished, calm tool, not a developer page: clear type, generous spacing, records on cards, friendly empty states.

It adapts **Huston Logic v3** (`huston-tech-site/docs/STYLE-GUIDE.md`, the website's guide) to an app. Kept from v3:
the palette and its contrast table (§2), the radius scale and the green-tinted shadows (§4), the rust focus ring and
the slow underline (§7), sentence-case labels, and the banned list (§13). Departures, stated plainly:

- **System fonts only.** AGENTS.md wins over v3's Outfit, Inter and Newsreader: no web fonts. Headings ask for a
  rounded system face first (`ui-rounded`, then `system-ui`), so Safari and Apple devices get a softer heading; other
  browsers get the plain system face. There is no second voice (no italic serif line).
- **No hero, doors, arc, ring, card stack or tilt.** They are website-only signature elements (v3 §5, §6, §7.7, §7.8).
  The board never uses the Huston Logic mark: each copy belongs to its owner.
- **Cards are allowed for records.** A deal, a contact, a task and a rule are "objects you could hold" in v3's terms
  (v3 §4), so each gets a card. Lists of lines (the brief, the change log, a timeline) stay unboxed rows on one panel,
  separated by dividers. So are tasks (run 12): a list of tasks is one panel of rows (§7.24), not a card each.
- **One subtle glow at the top of the page** (v3's `glow-green`, small and faint), behind the app bar. No other glows.
- **The accent comes from the settings.** v3's green is the default `--accent`; the owner can set another (§2).

It is not a marketing page, a dashboard of big numbers, or a dark "pro tool".

## 2. Color

All colors are the `:root` tokens in `public/board.css`; nothing else in the repo names a color. Values are v3's.

| Token | Hex | Use |
|---|---|---|
| `--silver` | `#F3F5F4` | Page background |
| `--silver-2` | `#E8EEEA` | Quiet panels: the outside-text block, the footer |
| `--white` | `#FFFFFF` | Cards, panels, the app bar, the tab bar, the side bar |
| `--ink` | `#29332D` | All body and heading text |
| `--ink-2` | `#4A5750` | Secondary text: fact labels, dates, captions, inactive tabs |
| `--green` | `#2B6455` | The default accent |
| `--green-deep` | `#1E4A3D` | Not used by the board yet (kept for the token map) |
| `--green-edge` | `#4E9A7C` | Decorative only, never text |
| `--tint` | `#E6F1EB` | Tag fills (a stage name, "Active"); the note panel |
| `--glow` | `#B4DEC8` | The one glow at the top of the page, inside a radial gradient only |
| `--mint` | `#CDE6D8` | Text selection |
| `--rust` | `#994D34` | Focus ring, slow underline, "Overdue", "Paused", "Undone", the "From outside" label |
| `--line` | `#D3DAD6` | Decorative borders only (never the only edge of a control) |

**The accent.** `--accent` is what makes a copy feel like the owner's: the current tab, primary buttons, card-title
links and standalone links. It defaults to `--green`. The owner sets another with `update_settings` (`accentColor`,
`#rrggbb`); the Worker serves it as `/theme.css` (`:root{--accent:#…}`), linked after `board.css` (decision 0015).
A colour is refused unless **white text on it, it as text on white, on `--silver` and on the darkest point of the glow
(`--glow-soft` over silver, `#d3e9de`) all reach 4.5:1** (`src/services/accent.ts`); the message says to pick a
darker colour. Derived tokens: `--accent-tint` (12% accent on
white: the current-tab pill and the side bar's current row) and `--on-accent` (white, text on accent). Accent text is
only ever placed on white or silver, never on `--accent-tint`, so the 4.5:1 rule holds for every accent; text on the
tint is `--ink`.

Translucent edges and shadows are tokens too: `--edge` (card border, ink at 10%), `--divider` (ink at 12%),
`--underline` (the permanent link underline, ink at 35%), `--glow-soft`, `--glow-fade` and `--glow-none` (the stops
of the one glow: v3's `glow-green` at lower strength, 30 × 24rem on phones, 44 × 30rem wide, top right), and the
shadows in §4.

**Contrast (WCAG 2.2, computed, from v3):**

| Pair | Ratio | Passes for |
|---|---|---|
| `ink` on `silver` / `white` / `silver-2` / `tint` | 11.9 / 13.1 / 11.1 / 11.3 | All text |
| `ink-2` on `white` / `silver` / `silver-2` | 7.6 / 6.9 / 6.4 | All text |
| `green` (default accent) on `white` / `silver` / `tint` | 6.9 / 6.3 / 5.9 | All text |
| white on `green` | 6.9 | All text (primary button) |
| `green` on the glow's centre (`#d3e9de`) | 5.4 | All text |
| any accent the settings accept, on `white` / `silver` / the glow's centre, and white on it | 4.5 or more | All text (checked on input and again in `/theme.css`) |
| `rust` on `white` / `silver` / `tint` / `silver-2` | 6.1 / 5.5 / 5.2 / 5.2 | All text |
| `rust` focus ring on `silver` / `white` | 5.5 / 6.1 | Non-text 3:1 |
| `line` on `silver` | 1.3 | Decorative only |

## 3. Typography

System fonts only, no font files (AGENTS.md).

- `--font-text`: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` for everything
  except headings.
- `--font-display`: `ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` for
  headings, the business name and card titles.

| Element | Size (phone → wide) | Weight | Line height | Tracking |
|---|---|---|---|---|
| H1 (page title) | 30 → 38px (`clamp`) | 700 | 1.1 | −0.025em |
| H2 (section) | 21 → 23px | 700 | 1.2 | −0.015em |
| Card title | 18px | 600 | 1.3 | −0.005em |
| Business name (app bar, side bar) | 18px | 700 | 1.2 | −0.01em |
| Body, fact values | 17px | 400 | 1.55 | 0 |
| Lede under the H1 | 18px, `ink-2` | 400 | 1.5 | 0 |
| Fact labels, dates, captions | 15px, `ink-2` | 500 | 1.45 | 0 |
| Tab label (phone) | 13px | 600 | 1.2 | 0 |
| Tag, the "From outside" label | 14px | 600 | 1.3 | 0 |

Body text is never under 17px, and secondary text never under 15px except the tab labels, which sit under an icon.
Measure: prose at most 40rem (about 70 characters). Sentence case everywhere: no `text-transform`, no letter-spaced
caps, no monospace. Numbers in counts and values use tabular figures.

## 4. Space, shape, depth, grid

**Spacing scale (px):** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64. Phone gutters 16px; wide 32 to 40px.

**Grid:** phone, one column; wide (60rem and up), a 16rem side bar and the content column (at most 72rem). Card
lists become an auto-filling grid (`minmax(17rem, 1fr)`) from 40rem up.

**Radius** (v3's scale):

| Token | Value | Use |
|---|---|---|
| `--r-field` | 10px | Small boxes: the monogram tile, the download rows' icon |
| `--r-btn` | 12px | Buttons, nav rows, the tab pill |
| `--r-card` | 14px | Cards and panels |
| `--r-pill` | 999px | Tags, the "From outside" label, counts |

**Shadows** are green-tinted (`rgba(31,61,49,…)`), never grey:

| Token | Use |
|---|---|
| `--shadow-card` | Cards and panels: a 1px contact shadow plus a soft drop (lighter than v3's hero card, because a board shows many cards at once) |
| `--shadow-bar` | The phone tab bar, lifting it off the content |

**Cards vs. no cards.** A card is a record: a deal, a contact, a rule, a "More" destination. Lines of a
document (the brief, the change log, a timeline, the download list) and lists of tasks (§7.24) sit as rows on one
white panel with dividers.
Facts are label/value pairs (`dl`): one grid per list, labels in `ink-2` in a column as wide as the longest label,
values beside them.

## 5. Layout: the Home first screen

The home page is **Today** (`/`). Measured at 375 × 812 and 1280 × 800 (`npm run screenshots`).

```
Phone (375)                          Wide (1280)
┌ app bar ───────────────────────┐   ┌ side bar ───┬ content ─────────────────────────────────┐
│ [F] Fernwood Engineering       │   │ [F] Fernwood│ Today  Wednesday Nov 18                  │
├────────────────────────────────┤   │             │ summary sentence                         │
│ Today  Wednesday Nov 18        │   │  Today      │ Overdue                  Pipeline        │
│ summary sentence               │   │  Pipeline   │ ┌ task card ─────────┐   ┌ stage rows ─┐ │
│ Overdue                        │   │  Contacts   │ └────────────────────┘   └─────────────┘ │
│ ┌ task card ────────────────┐  │   │  Brief      │ Due today                Latest brief    │
│ └───────────────────────────┘  │   │  More       │ ┌ task card ─────────┐   ┌ 4 lines ────┐ │
│ Due today                      │   │    Rules    │ └────────────────────┘   └─────────────┘ │
│ ┌ task card ────────────────┐  │   │    Changes  │                                          │
│ Pipeline (stage rows)          │   │    Export   │ footer                                   │
│ Latest brief                   │   └─────────────┴──────────────────────────────────────────┘
├────────────────────────────────┤
│ Today Pipeline Contacts Brief More │  fixed tab bar, safe-area inset below
└────────────────────────────────┘
```

Order on Today: the H1 with the owner's date beside it, one summary sentence, Overdue, Due today (or the empty
state), then Pipeline (one row per open stage with its count, each a link to that stage on `/pipeline`) and Latest
brief. From 72rem the due cards take the left column (3fr) and Pipeline and Latest brief the right (2fr).

## 6. Signature elements

- **The monogram:** the first letter of the business name on an accent tile (white letter), beside the name in the
  app bar and side bar. It is the only "logo" a copy has; there is no image logo.
- **The accent** (§2) on the current tab, primary buttons and links: one colour carries the owner's brand.
- **The "From outside" label:** a rust outline pill with the words, in front of every value that came from a form
  or an import (decision 0013). Never color alone, never a link's text.

## 7. Components

### 7.1 App bar (phones, under 60rem)
White, 64px tall, `--shadow-card`'s contact line under it; the monogram (32px, `--r-field`) and the business name
(default "Pipeline"), linking to Today. It scrolls with the page (not sticky), so the phone keeps its height for
content.

### 7.2 Tab bar (phones)
Fixed to the bottom, white, `--shadow-bar`, padded by `env(safe-area-inset-bottom)` (the viewport sets
`viewport-fit=cover`). Five equal tabs: Today, Pipeline, Contacts, Brief, More. Each tab is a link at least 56px tall:
a 24px line icon over a 13px label. Current tab: `aria-current="page"` (or `"true"` for a page inside More, or a deal
inside Pipeline), the icon on a 56 × 30px `--accent-tint` pill and the label in `--accent` at 700. Others: `ink-2`.
The More tab's link reads "More pages" to assistive technology (a visually hidden word), because "More" alone is not
descriptive link text. The page reserves the bar's height plus the inset at its bottom, and `scroll-padding-bottom` keeps a focused element
above the bar (WCAG 2.4.11).

### 7.3 Side bar (60rem and up)
The same `nav`, laid out as a 16rem white column, sticky, full height: business name at the top, then the five items
as 44px rows with icon and label, and Rules, Changes and Export indented under More (text only: their icons show on
the More page). Current row: `--accent-tint` background, `ink` label at 700, icon in `--accent`.

### 7.4 Page head
H1, then a lede in `ink-2`. A deal page puts a "Back to the pipeline" link above the H1.

### 7.5 Record card (`.card`)
White, `--r-card`, 1px `--edge` border, `--shadow-card`, padding 16 (20 from 40rem). Title in the display face at
18px; when it is a link it is in `--accent` with the slow underline on hover and focus. Facts below as a `dl` of
label/value pairs. A status sits beside the title as a tag. No hover lift, no hover shadow.

### 7.6 Panel (`.panel`)
A card without a title row, holding rows (brief lines, changes, timeline entries, downloads) split by 1px `--divider`
lines.

### 7.7 Tags (`.tag`)
Pill, 14px 600: `ink` on `--tint` for neutral states (a stage, "Active"), rust outline on white for warnings
("Overdue", "Paused", "Undone"). Words always carry the meaning.

### 7.8 Empty state (`.empty`)
A quiet white panel (`--white`, `--r-card`, `--edge`, no shadow): one line saying what is missing ("Nothing due today."),
one line in `ink-2` saying how things get here (by talking to the AI app, by the website form, by a rule). No
illustration, and no promise of a button the page doesn't have.

### 7.9 Outside text (`.outside`, `.outside-block`)
The label: a rust outline pill "From outside". The block (a form message): a `--silver-2` panel, `--r-card`, the
label and "Message as received" on top, then the text as received (`pre-wrap`). No left border.

### 7.10 Buttons and links
- **Primary button** (`.button`): `--accent` fill, white label, 17px 600, at least 48px tall, padding 0 20px,
  `--r-btn`, an inline icon before the label when one helps (download). Hover and focus: the slow underline draws on
  the label. No color change, no scale.
- **Small button** (`.button-small`): the primary button at 44px tall, 16px, padding 0 16px, for a button inside a
  card (Move).
- **Quiet button** (`.button-quiet`): white fill, `ink` label, a 1px `ink-2` inset edge, 44px tall, for a second
  action or a button on a tinted panel (Undo).
- **Standalone link:** `--accent`, with the slow underline.
- **Link in a sentence:** inherits the text color with a permanent 1px `--underline` underline (`.25em` offset); the
  rust underline draws over it.
- **The slow underline:** a 1.5px `--rust` background under the text, `background-size` 0 → 100% over 0.5s
  `cubic-bezier(.2,.7,.2,1)`, drawing left to right; instant under reduced motion.
- **Focus ring:** 2px solid `--rust`, offset 3px, radius 4px (follows the element's radius on cards and rows).
  Never removed.

### 7.11 More page rows
Each destination (Rules, Changes, Export) is one link styled as a card: icon tile, label in the display face, a
one-line description in `ink-2`. The whole card is the link.

### 7.12 Footer
`ink-2`, 15px, one line: "Add leads, edit contacts and deals, and move, log and undo here, or change anything by
talking to your AI app." (decision 0018).

### 7.13 View switch (`.view-switch`)
Two views of one tab (People / Companies, decision 0016): a white strip with an `--edge` border and `--r-btn`
radius holding two links, each at least 44px tall, `ink-2` at 600. The current one is `aria-current="page"` on an
`--accent-tint` fill, `ink` at 700. A list of links, not a second `nav`.

### 7.14 Search form (`.search`, `.field`)
A GET form with `role="search"` and no JavaScript. Each field is a visible label (600), an optional hint in `ink-2`
at 15px (tied with `aria-describedby`), then the control: white, 48px tall, 1px `ink-2` border (an edge a control can
be seen by, never `--line`), `--r-field` radius, the body font. The submit is a primary button (§7.10). Phone: the
search box on its own row, the other control and the button below; from 40rem, one row.

### 7.15 Card sub-parts
`.card-sub`: one line under a card title in `ink-2`, 15px ("2 open deals, value 17,900"). `.card-sub-head`: a small
heading inside a card (15px, 600, `ink-2`, the text face) on a `--divider` line, when a card holds two lists. Links in
`.card-links` sit above a card title's whole-card link, so both can be tapped.

### 7.16 Change banner
Replaced by the status corner, §7.25 (run 12). The `.banner` and `.timer-bar` styles are gone.

### 7.17 Move to form (`.move`, `.move-details`)
A select of every stage (open ones first, then "Close the deal": Won, Lost, Not now; the deal's own marked
"(current)") and a small Move button, in one row that wraps when narrow. The select is 44px tall with a 1px `ink-2`
edge (§7.14). On cards and list rows it sits under a native disclosure, "Move to another stage" (15px, 600, `ink-2`,
the browser's own triangle), on a `--divider` line, so a card stays short; its label is then read, not shown. On the
deal page and the refused page it is open, with a visible "Move to" label. It sits above the card title's whole-card
link.

### 7.18 Pipeline board (`.board`, `.column`, `.stage-jump`, `.closed`)
- **Phone (under 40rem):** a row of jump links (white pills with an `--edge` border, label and count, 44px) above the
  stacked stage sections; each section is an h2 with its count line and the deal cards; the Closed summary comes last.
- **From 40rem:** the columns sit side by side, 14rem each (sharing spare room), as `--silver-2` lanes (`--r-card`, 12–14px padding) with
  white cards, in a region (`role="region"`, labelled, `tabindex="0"`) that scrolls sideways on its own; from 60rem it
  runs into the content's right padding. Lane headings are 18px. The Closed summary ("Closed" in `ink-2` 600, then one
  white box per closed stage with its label and "3 deals") sits above the board.
- **Dragging** (desktop, `board.js`): a draggable card shows a grab cursor; while dragging, the card fades to half,
  every stage it can go to gets a 2px dashed `ink-2` outline, and the one under the pointer a 3px solid `--accent`
  outline, the `--accent-tint` fill and the words "Drop here". No motion.
- **List view:** the stage sections of the phone layout at every width, each deal a row on one panel; from 40rem the
  Move to disclosure sits in a 19rem column on the right.

### 7.19 Confirm and refused pages
The confirm page (closing a deal, or an undo that removes records): the question as the h1 ("Mark … as Won?"), one lede line, then the primary button
("Mark as Won") and a Cancel link side by side, 44px tall. The refused page: an h1 saying what didn't happen, the
service's message as the lede in `ink`, the form again in a card at most 28rem wide, and "Back to the page".

### 7.20 Record forms (`.record-form`, `.field`, `.error-summary`; decision 0018)
Add a lead, Add a deal, a new deal for a contact, Qualify, Edit contact and Edit deal are pages: a "Back to …" link,
the h1, one lede line, the fields in one white card (two cards under h2s, Contact and Deal, on Add a deal), then the
primary button ("Add the lead", "Save changes") and a Cancel link side by side, 44px or more. A checkbox ("Create a
deal", "Add anyway") is a 24px box with its label beside it in one 44px row (`.check`). Each field: a visible label (600), "(required)" in words in
`ink-2` 500, an optional hint (§7.14), the control (48px, 1px `ink-2` edge, `--r-field`; textareas 7rem, resizable).
A value that came from outside has the "From outside" pill under its label, at its own width, read with the control
(`aria-describedby`). A date is a group: a legend, then Date and Time side by side (wrapping on a phone), the time
optional. Forms are `novalidate`: the server checks and answers. A refused form: an error summary at the top, focused
on load (white, 2px rust edge, `--r-card`, an h2 such as "2 things to fix", each message a rust link to its field), and
above each wrong control its message in rust 600, with the control's edge 2px rust. The words carry the state, never
colour alone.

### 7.21 Task actions, Add a task and Log (`.task-actions`, `.add-details`)
At the foot of every task card, on a `--divider` line: Done (a small quiet button, §7.10) and a Snooze disclosure
(`ink-2` 600, like Move to). Open, it shows two quiet buttons ("Tomorrow morning", "Next week"), one hint line on what
they mean, and a date and time with a small Snooze button. Add a task and Log are disclosures under their section (the
summary in `--accent` 600, 44px); open, the form sits in a white bordered box. Hidden words name the task in every
button, so a screen reader can tell the cards apart. Add a deal (§7.10 primary) and Add a lead (quiet) sit side by side
under the lede on Today, Pipeline and Contacts; Leads has Add a lead alone, as the primary button (decision 0028).

### 7.21a A lead's page (`.lead-card`; decision 0028)
Only for someone with a lead status. The first section of the left column, an h2 "Lead", holds one white card: the
status line ("Lead status: Not now, since Thu Nov 19", 600, `ink`), then the status menu (a select and an optional
check-back date as §7.20 fields, then a small "Save status" button), then, on a `--divider` line, "Qualify" as a
primary button. A Qualified person's card has the status line only. The Ask Claude section (§7.23) holds one prompt,
"Draft an intro in my voice", at the top of the right column. On a deal page, "Back to leads" is a small quiet button
on a `--divider` line under the Move to form; it opens a confirm page (§7.19) with a "Lead status" select.

### 7.22 Phone actions (`.reach`; decision 0021)
At the foot of the contact card on the deal page and the Details card on the contact page, on a `--divider` line,
under the facts (so the number and address, labelled "From outside" when they are, sit right above): a row of Call,
Text and Email in equal columns, then a hint line in `ink-2` 15px ("Called, texted or emailed? Log it in one tap."),
then a row of "Log the call", "Log the text", "Log the email", one column per channel, so each Log button sits under
its link. Only channels with a usable value get a column; a value that fails the check gets one `ink-2` line saying
why instead. Phone (under 60rem): Call, Text and Email are primary buttons (§7.10) 56px tall; the Log buttons are
quiet buttons 56px tall, centred, wrapping to two lines in a narrow column. Wide: Call, Text and Email turn quiet
(white, ink, 44px), because a desktop rarely dials; the Log buttons are 48px. After a tap on Call, Text or Email the
script focuses the matching Log button and fills it with `--accent` (white label), so the next tap logs it. Link texts
are fixed words, never the number or address. No icons.

### 7.23 Ask Claude (`.ask`, `.copy-status`; decision 0021)
A section on the deal page after Next step: an h2 "Ask Claude", one `ink-2` note on what the links do, then one white
panel with a row per prompt, split by a divider. Each row: the link as a primary button (full width on a phone, its
own width wide; hidden words say it opens a new tab), "Copy prompt" beside it as a small quiet button (only when the
script can use the clipboard; it starts `hidden`), a polite live line in `ink-2` that says "Copied.", and a "Show the
prompt" disclosure (`ink-2` 600, like Snooze) holding the prompt in a labelled read-only textarea (§7.20 field).
Nothing pops up and nothing disappears on its own.

### 7.24 Task row (`.task-rows`, `.task-row`; run 12)
One list of tasks is one white panel (`--white`, 1px `--edge`, `--r-card`, no shadow, no padding); rows are split by
1px `--divider`. Each row (`li.task-row`, min 44px) holds, left to right: the Done box (a 24px box in a 44px target;
hidden words "Done: <task>"; a static filled box when the task is done), the row line (`details.task-open`'s
`summary`, plain text, no links) and, when the task has sub-tasks, `details.task-subs` whose summary ("3 open
sub-tasks") sits at the row's right edge (the row line reserves its width).
- **Row line, 40rem and up:** a grid `minmax(0,1fr) 10rem 12rem 1.5rem`: title (17px, one line, ellipsis), due
  (15px `--ink-2`, tabular figures, "Overdue" in rust beside it when it was due before today), belongs (project, deal
  or person; left out where the page already says it), then a CSS chevron that turns when open.
- **Phone:** the title up to two lines, then the due and belongs cells side by side on a second line in `--ink-2` 15px.
- **Open content:** 12px padding, a `--divider` top line; the description, one links line (Open the deal, Open the
  person, Open the project), then one wrapping action line with 8px gaps (Start timer, Snooze, Edit, Add a sub-task,
  Move up, Move down).
- **Nested rows** (sub-tasks): the same panel without its own border, set in 44px per level, a divider on top.
- No hover lift. The focus ring (§7.10) is on the row line, the Done box and every button. Today keeps cards until its own task.

### 7.25 Status corner (`.corner`; run 12)
Replaces the old change banner and Stop bar. `<div class="corner" data-region="corner">` is the first thing in
`.app-body`, `position: sticky; top: 0` above the content, its chips aligned to the right edge (16px side padding,
32px from 60rem). The strip itself is `pointer-events: none` and an empty corner has no height, so it never blocks
a click or pushes the page down; it takes no focus and traps none, and tab order follows the page order.
- **Fill:** the chip and a non-empty notice are bold: `--accent` fill, `--on-accent` text (15px, 600), `--r-card`,
  `--shadow-bar`, 8px 12px padding, at most `min(100%, 28rem)` wide. Buttons inside are 44px tall, white text with a
  1px inset `--on-accent` edge and no fill (a quiet button inverted), with the slow underline on hover and focus.
- **Timer chip** (only while a timer runs, outside the live region): "since 9:10 AM" in a `<time>` with tabular
  figures, the who (cut to 32 characters with "…"), Stop and Undo, each its own form.
- **Notice** (`role="status"`, always present, empty when there is nothing): the change in a few words ("Done: Send
  the plan") with Undo, or after a timer stops, "Time logged: 1:16 PM to 1:58 PM" with Edit or add notes, Undo and
  Close. The Time logged note wins when both apply and goes after two minutes or on Close.
- **Focus ring (the one exception to the rust ring, §1):** rust on the accent fill is about 1.1:1, so inside the
  corner the ring is 2px `--white` at a 2px offset (on the fill, 4.5:1 or better for any accepted accent).
- **Scroll room:** `html:has(.corner-chip, .corner-notice:not(:empty))` sets `scroll-padding-top: 21rem`, the tallest
  case at 320px (the wrapped Time logged note under the wrapped chip), so Tab never leaves a focused control under
  the sticky corner (WCAG 2.4.11). An empty corner adds none.
- No animation, nothing that disappears on its own other than the two-minute rule above.

## 8. Line art and icons

Inline SVG in `src/board/icons.ts`, 24 × 24 viewBox, `stroke: currentColor`, stroke 1.75, round caps and joins, no
fill, `aria-hidden="true"` (the text label always sits beside them). The set: today (a calendar with a dot),
pipeline (three columns of falling height), contacts (two people), brief (a page with lines), more (three dots),
rules (two sliders), changes (a clock with a turning arrow), export (an arrow into a tray). Nothing else: no stock
icon packs, emoji or decorative icons.

## 9. Motion

Short motion that answers a tap, and nothing else: a row opening, a notice arriving, a row leaving when it is done.
Each lasts `--motion-fast` (160ms) on `--ease`, runs once, and only changes `opacity` and, for the notice and the timer
chip, a 4px `translateY`. The slow underline on links and buttons (0.5s) answering a hover or focus stays as it is.
No page load animation, no hover lift on cards, nothing loops or moves by itself, nothing is tied to scrolling.
Everything sits inside `prefers-reduced-motion: no-preference`; under `reduce` every animation and transition is off
and the end state shows at once (`/live.js` also skips its 160ms wait before a row leaves).

## 10. Responsive

| Width | Behavior |
|---|---|
| under 40rem (640px) | One column; app bar on top, tab bar at the bottom; facts stacked |
| 40rem to 60rem | Card lists in a grid of two |
| 60rem (960px) and up | Side bar on the left instead of the app bar and tab bar |
| 72rem (1152px) and up | Today in two columns (due cards; pipeline and brief); the deal page in two columns (contact and deal; next step, tasks and timeline) |

Checked at 375 and 1280px wide with no horizontal scroll (`npm run screenshots`). Long values wrap anywhere
(`overflow-wrap: anywhere` on `main`).

## 11. Accessibility (WCAG 2.2 AA; the `a11y` check)

- Contrast: §2; the accent rule makes every accepted accent pass for text.
- One `<h1>` per page from the page body, logical heading order, landmarks (`header`, one `nav` with a label,
  `main#main`, `footer`), a skip link first, `lang="en"`, a meta description on every page.
- Every tap target at least 44 × 44 (tabs 56 tall). The rust focus ring on everything focusable.
- Icons are `aria-hidden`; every link has its text. The current page is `aria-current="page"`.
- The fixed tab bar never hides a focused element (`scroll-padding-bottom`).
- Outside text is labelled with words, never color alone.
- `npm run screenshots` runs axe with the a11y check's tags on every route at both widths.

## 12. Performance budget (the `lighthouse` check: 90 or higher on mobile, all four categories)

- No font files, no images. Two small stylesheets (`/board.css` static, `/theme.css` from the Worker). Small scripts,
  each under 3 KB gzipped and `defer`: `/live.js` on every signed-in page (decision 0062), `/board.js` on the
  pipeline board, deal pages and contact pages (decision 0021), `/push.js` on Notifications (decision 0030); a page
  outside the sign-in has none.
- The glow is one CSS radial gradient; no `filter`, no `backdrop-filter`.
- Icons are inline SVG.

## 13. Banned

- v3's bans: purple, blue or any second accent besides the owner's; gradient washes (only the one glow); gradient
  text; glassmorphism and `backdrop-filter`; grey drop shadows; **left-border callouts and cards with a colored
  stripe**; all-caps or letter-spaced labels; monospace labels; accenting one word in a heading; emoji, stock icons
  and illustrations; loops, carousels, parallax and scroll-linked motion; pop-ups.
- Board-specific: web fonts; inline styles (the CSP refuses them; `/theme.css` carries the accent); big-number stat
  tiles; hover lift on cards; color as the only sign of state; outside text as a link's text or in a page title.

## 14. Acceptance check

1. `npm run screenshots`: every route at 375 and 1280, no axe violations, no horizontal scroll, and the screenshots
   in `.owner-review/screenshots/` look finished at both widths.
2. `npm run test:lighthouse` passes the existing thresholds.
3. `npm run check` passes; the board tests still prove escaping, the "From outside" labels, one H1 and the headers.
4. Every color in `public/board.css` is a `:root` token; no color appears anywhere else in `src/` except the accent
   module's checks.
5. Setting an accent with `update_settings` changes the current tab, buttons and links, and a too-light colour is
   refused with a plain-English fix.

## Kept on purpose

(Nothing yet. The owner adds entries here: `- <item>: <reason>`.)
