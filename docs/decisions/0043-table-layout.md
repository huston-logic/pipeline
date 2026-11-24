# 0043: Table layout

Run 5, task P10, 2026-11-23. Builds on 0042 (saved views store a layout and columns), 0016, 0017 and 0020 (the lists,
the Pipeline List and the 200-row cap) and 0027 (the People switch).

## Context

The owner's words: every list (the People views and the Pipeline List) can show as cards or as a table, one line per
record, first column pinned, the other columns scrolling sideways on a phone, sortable headers, real table markup, no
JavaScript. Columns come from the view, with sensible defaults. The Pipeline List replaces today's, which looks almost
the same as the Board. 0042 stored `layout` and `columns` on a view and drew a table layout as cards until now.

## Decision

- **Which lists.** Contacts, Leads, a person status's default view, a saved people view, the Pipeline List (including
  one stage's list, `?view=list&stage=<key>`) and a saved deals view. Companies and the Board (the kanban) stay as
  they are.
- **Choosing.** A labelled list of two links, "Show as": Cards and Table (`layoutSwitch` in `src/board/table.ts`),
  `aria-current="page"` on the shown one, under the view switch. `layout=cards` or `layout=table` in the address
  decides for that visit only; GETs never write, so a saved view's stored layout changes only by `update_view`. With no
  `layout`, a saved view uses its stored layout; People lists open as cards and the Pipeline List as a table (that is
  how it stops looking like Board). Any other `layout` value is ignored. The switch's links keep every other
  parameter, and the Contacts and Leads search forms carry `layout=table` in a hidden field.
- **Markup.** `dataTable` (`src/board/table.ts`): a `<div class="table-scroll" role="region" aria-label="<name>, as a
  table" tabindex="0">` around a `<table class="data-table">` with a visually hidden `<caption>` (the view's name, how
  many, the sort), `<th scope="col">` headers and, in each row, the first cell a `<th scope="row">` holding the
  record's link. The wrapper scrolls sideways (`overflow-x: auto`) so the page never does; the first column is
  `position: sticky; left: 0` on a white (header: silver) background so it stays readable. Cells and header links keep
  a 44 px minimum height. No JavaScript and no new script.
- **Sorting.** A header is a link only for a column the module can sort by (people: name, business, next task, last
  activity, added; deals: value, next date, days in stage, added). It sets `sort=<key>-<dir>` and keeps every other
  parameter (filters, view id, stage, layout, search); the first click gives the sort's natural direction, a click on
  the current column flips it. The current column has `aria-sort` and a visible arrow (hidden from screen readers,
  which have `aria-sort`). Only the fixed sort lists of `view-spec.ts` are accepted; an unknown `sort` is the view's
  own sort, no error. In the address `sort` overrides a saved view's stored sort for that visit only. Contacts and
  Leads keep their own sort parameters (`name-asc` style and `next_task` style) and their own sort lists.
- **Columns.** A saved people or deals view uses its stored columns (validated keys, custom fields as
  `fields.<key>`, headed with the field's label); a default view and the Pipeline List use the module's defaults from
  `view-spec.ts`: people Name, Company, Person status, Sub-status, Next task, Last activity; deals Deal, Person,
  Stage, Value, Next step, Days in stage. A stored first column that is not the record's link is put right. The
  built-in Contacts and Leads tables cannot offer those defaults, because their reads (0016, 0022) carry other
  data: Contacts shows Name, Company, Open deals and Last activity; Leads shows Name, Company, Status, Last contact,
  Next task and Added.
- **Outside text** in a cell is labelled "From outside" exactly as on the cards (`labelled`, `contactLink`,
  `dealLink`): a name or title from outside is never a link's text; a company, email, phone, source or custom field
  value from outside is labelled in its cell. Emails and phones are plain text in a table (no `tel:` or `mailto:`).
  Empty cells say what is missing in words ("None", "No task").
- **The Pipeline List** is now one table of every open deal (or one open stage's), read by `dealsInView` with the
  deals default sort (longest in their stage first), not the old stage-by-stage rows. It has no Move to form per row
  (the Board's cards and the deal page keep them) and no stage sections; the closed counts still sit under it. The
  deals read now also returns the person's source, for the Source column.
- **The 200-row cap** and "Showing the first 200 of N deals, in this view's order." (0020) apply to the table as to the
  cards. The Board's "Show all N in <stage>" link still goes to the stage's list.
- **Titles and descriptions** name a layout that is not the page's usual one ("Contacts as a table"), so every route in
  `boardRoutes` keeps a unique title and description. `boardRoutes` gains `/contacts?layout=table` and
  `/people?view=vw_seed01&layout=table` (the Pipeline's List is a table already), so the accessibility and Lighthouse
  checks cover both layouts.
- **Style.** `public/board.css` only, tokens only (`--white`, `--silver-2`, `--line`, `--edge`, `--ink`, `--underline`).

## Why

A real table is what a screen reader and a keyboard user need for many fields per record; the sticky first column and
the scrolling region keep a phone usable without a page-wide sideways scroll. Reusing `dealsInView`/`peopleInView` and
the saved views' columns means one table for every list and no SQL in a page. Keeping the choice in the address keeps
GETs free of writes and works with JavaScript off.

## Consequences

- The Pipeline List no longer has a Move to control per deal: the Board, the deal page and the deal's own Move to form do.
- A view with 12 columns scrolls sideways a long way; that is what the region is for.
- Contacts and Leads have their own column sets until their reads carry the people-view fields.
- The deal page links and the Board are unchanged. Companies has no table layout.
